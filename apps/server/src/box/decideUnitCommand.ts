/**
 * What the agent may ask the privileged helper to do, decided here first.
 *
 * A box runs the agent as an unprivileged service user with an ordinary shell,
 * and that is the point: everything the agent can do, it can do as itself. The
 * two things it legitimately cannot do as itself are manage its own systemd
 * units and have them start at boot — so exactly those are delegated, through
 * one sudoers rule naming one root-owned helper
 * (`infra/install/t3-unit-helper.sh`) with a closed vocabulary of seven verbs.
 *
 * **This module is not the security boundary, and reading it as one is the
 * mistake worth naming up front.** The boundary is the helper, on the box,
 * running as root, which re-derives every rule below from the argument vector
 * it is handed and refuses on its own authority. It has to be: the agent has a
 * shell, so it can call the helper directly and never come through here at all.
 * What this module buys is a refusal that arrives before a round trip, worded
 * for a reader, and journalled in the same table as everything else the agent
 * did to the box — plus a test suite that can state the world without a
 * machine. `decideUnitCommand.test.ts` asserts the two copies agree by parsing
 * the helper's constants block, the same way `environment-install.test.ts`
 * checks the installer.
 *
 * The rules that are worth stating twice:
 *
 * - The prefix is enforced by **matching an allowlist after canonicalising**,
 *   never by `startsWith`. `t3-app-../other.service` passes any string-prefix
 *   test ever written; it fails here because `../other` is not lowercase
 *   alphanumerics and dashes.
 * - Nothing the caller supplies becomes unit-file content. The helper generates
 *   the unit from a template with `User=` pinned to the unprivileged service
 *   user, so even a permitted unit cannot run as root. What travels from here
 *   is a program path, its arguments, a working directory, a port and a
 *   description — each allowlisted, and the arguments most strictly of all,
 *   because a newline in one would let a caller append its own `User=root` line
 *   to a file root is about to write.
 * - Path containment is decided on the **resolved** path, and only the helper
 *   can resolve it. What this module can say is that a path with a `..` in it,
 *   or one that is not absolute, is refused before it goes anywhere —
 *   `unitPathIsContained` is the containment rule itself, exported so the same
 *   lookalike cases (`…/apps-elsewhere`) are pinned by a test here as well as
 *   by the container.
 *
 * @module Box
 */

// ── the vocabulary, mirrored from the helper ─────────────────────────────────

/**
 * The seven verbs, and there is no eighth.
 *
 * Closed rather than open because the value of the helper is entirely in what
 * it will not do. A pass-through verb — anything shaped like "run this
 * systemctl subcommand" — would give back the `NOPASSWD: /bin/systemctl` this
 * whole arrangement exists to avoid, one refactor later and by accident.
 *
 * Removal is deliberately absent. A unit this helper wrote is removed by
 * uninstalling the environment, which is a decision a person makes at a root
 * shell; an agent that can delete units at will can quietly undo the record of
 * what it started.
 */
export const UNIT_VERBS = [
  "create",
  "start",
  "stop",
  "restart",
  "enable",
  "disable",
  "status",
] as const;
export type UnitVerb = (typeof UNIT_VERBS)[number];

export const UNIT_PREFIX = "t3-app-";
export const UNIT_SUFFIX = ".service";

/** The first line of any unit the helper wrote, and the only proof it wrote it. */
export const UNIT_MARKER = "# Managed by t3-unit-helper";

export const UNIT_DIR = "/etc/systemd/system";
export const UNIT_SERVICE_USER = "t3env";

/** Everything the agent may point a unit at. Nothing outside it, ever. */
export const UNIT_DEPLOY_ROOT = "/var/lib/t3-environment/apps";

export const UNIT_HELPER_PATH = "/opt/t3-environment/libexec/t3-unit-helper";
export const UNIT_SUDOERS_PATH = "/etc/sudoers.d/t3-environment";

export const UNIT_NAME_MAX = 64;
export const UNIT_ARG_MAX = 512;
export const UNIT_ARG_COUNT_MAX = 32;
export const UNIT_DESCRIPTION_MAX = 200;

/** Below this, binding needs a capability — which is granted, never a uid. */
export const UNIT_PRIVILEGED_PORT_CEILING = 1_024;

/** The helper's exit code for "understood, and not allowed". */
export const UNIT_EXIT_REFUSED = 3;

const MIN_PORT = 1;
const MAX_PORT = 65_535;

// ── the allowlists ───────────────────────────────────────────────────────────
//
// Anchored, and expressed as "these characters and no others" rather than as a
// list of things to reject. A denylist has to anticipate the attack: it needs a
// rule for `..`, another for `;`, another for a fullwidth `Ｘ`, another for a
// right-to-left override, and it is wrong the first time somebody thinks of an
// eighth. These say what a name is, so everything that is not one is refused
// without having been foreseen.
//
// No `u` flag and no unicode classes on purpose: these are ASCII ranges, and a
// character outside them fails to match whatever it is.

const UNIT_STEM_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PATH_PATTERN = /^\/[A-Za-z0-9._/-]*$/;
const ARGUMENT_PATTERN = /^[A-Za-z0-9._/:=,@+-]+$/;
const DESCRIPTION_PATTERN = /^[A-Za-z0-9._,:/() -]+$/;

// ── requests and answers ─────────────────────────────────────────────────────

export interface UnitCreateFields {
  /** The program to run. Absolute, and inside the deploy root once resolved. */
  readonly exec: string;
  readonly args: ReadonlyArray<string>;
  /** Null means "the directory holding `exec`", which the helper derives. */
  readonly workingDirectory: string | null;
  /** Null means the unit gets no `PORT=` and no capability. */
  readonly port: number | null;
  readonly description: string | null;
}

export type UnitRequest =
  | { readonly verb: "create"; readonly name: string; readonly create: UnitCreateFields }
  | { readonly verb: Exclude<UnitVerb, "create">; readonly name: string };

export type UnitRefusalReason =
  | "unknown-verb"
  | "unit-name-empty"
  | "unit-name-too-long"
  /** It names something outside the range this helper manages at all. */
  | "unit-name-outside-prefix"
  /** It is in the range and is not a name: traversal, metacharacters, unicode. */
  | "unit-name-malformed"
  | "exec-missing"
  | "path-not-absolute"
  | "path-traversal"
  | "path-malformed"
  | "argument-malformed"
  | "argument-too-long"
  | "too-many-arguments"
  | "description-malformed"
  | "port-out-of-range";

export interface UnitRefusal {
  readonly reason: UnitRefusalReason;
  readonly headline: string;
  readonly remedy: string;
}

/**
 * A request the helper may be asked to carry out, with the name canonicalised.
 *
 * The canonical name travels rather than the caller's string for the same
 * reason `BoxPlan` carries the resolved service: what was checked and what is
 * executed must be the same value, and `t3-app-web` and `t3-app-web.service`
 * being the same unit is exactly the kind of difference that hides a bug.
 */
export interface UnitPlan {
  readonly verb: UnitVerb;
  readonly name: string;
  readonly create: UnitCreateFields | null;
  /**
   * True when the unit will be granted `CAP_NET_BIND_SERVICE` because it asked
   * for a port below 1024. Surfaced so the CLI can say it out loud — a
   * capability granted silently is a capability nobody reviews.
   */
  readonly needsBindCapability: boolean;
}

export type UnitCommandDecision =
  | { readonly outcome: "allow"; readonly plan: UnitPlan }
  | { readonly outcome: "refuse"; readonly refusal: UnitRefusal };

// ── names ────────────────────────────────────────────────────────────────────

/**
 * The one spelling of a unit name, so nothing downstream has two.
 *
 * Only ever appends the suffix. It does not trim, lowercase or strip anything:
 * a name that needed cleaning up to become valid is a name the caller did not
 * mean, and quietly repairing it is how ` t3-app-web` and `T3-APP-WEB` end up
 * addressing the same unit through two different code paths. Lowercasing in
 * particular is a trap — `İ`.toLowerCase() is two code points in some locales —
 * so the allowlist rejects capitals instead of folding them.
 */
export function canonicaliseUnitName(name: string): string {
  return name.endsWith(UNIT_SUFFIX) ? name : `${name}${UNIT_SUFFIX}`;
}

function refuse(
  reason: UnitRefusalReason,
  headline: string,
  remedy: string,
): { readonly outcome: "refuse"; readonly refusal: UnitRefusal } {
  return { outcome: "refuse", refusal: { reason, headline, remedy } };
}

function checkName(canonical: string): UnitRefusal | null {
  if (canonical === UNIT_SUFFIX || canonical.length === 0) {
    return {
      reason: "unit-name-empty",
      headline: "No unit was named.",
      remedy: `Name one, as \`${UNIT_PREFIX}<something>\`.`,
    };
  }
  if (canonical.length > UNIT_NAME_MAX) {
    return {
      reason: "unit-name-too-long",
      headline: `A unit name may be at most ${UNIT_NAME_MAX} characters; that one is ${canonical.length}.`,
      remedy: "Shorten it.",
    };
  }
  if (!canonical.startsWith(UNIT_PREFIX)) {
    return {
      reason: "unit-name-outside-prefix",
      headline: `"${canonical}" is not a unit T3 manages.`,
      remedy: `The helper only ever touches units named \`${UNIT_PREFIX}<something>${UNIT_SUFFIX}\`. Everything else on this machine belongs to somebody else — a database, a production API, somebody's cron job — and stopping one is not something anything here can decide.`,
    };
  }

  // The prefix has been *matched*, and now the rest is checked as a name in its
  // own right. This is the line that stops `t3-app-../other.service`: it has the
  // prefix, and `../other` is not a stem.
  const stem = canonical.slice(UNIT_PREFIX.length, canonical.length - UNIT_SUFFIX.length);
  if (!canonical.endsWith(UNIT_SUFFIX) || stem.length === 0 || !UNIT_STEM_PATTERN.test(stem)) {
    return {
      reason: "unit-name-malformed",
      headline: `"${canonical}" is not a unit name.`,
      remedy: `After \`${UNIT_PREFIX}\` it may hold lowercase letters, digits and dashes, and must start and end with a letter or digit. No slashes, no dots, no \`@\`, no spaces.`,
    };
  }
  return null;
}

// ── paths ────────────────────────────────────────────────────────────────────

function checkPath(value: string, label: string): UnitRefusal | null {
  if (!value.startsWith("/")) {
    return {
      reason: "path-not-absolute",
      headline: `${label} must be an absolute path.`,
      remedy: `Give the full path, somewhere under ${UNIT_DEPLOY_ROOT}.`,
    };
  }
  if (!PATH_PATTERN.test(value)) {
    return {
      reason: "path-malformed",
      headline: `${label} holds characters a path here may not.`,
      remedy:
        "Only letters, digits, dot, dash, underscore and slash. A path needing anything else is a path this cannot check.",
    };
  }
  // Refused on sight as well as on resolution. The resolution check is the one
  // that matters and it happens on the box; this one exists so the refusal can
  // say something true about what was typed.
  if (value.split("/").includes("..")) {
    return {
      reason: "path-traversal",
      headline: `${label} walks upwards with "..".`,
      remedy: `Paths into ${UNIT_DEPLOY_ROOT} are written downwards. The helper resolves symlinks before deciding anyway, so this would be refused there too.`,
    };
  }
  return null;
}

/**
 * Whether an already-resolved path lies inside a root.
 *
 * Two things make this correct, and both have been got wrong before:
 *
 * The trailing separator. `/var/lib/t3-environment/apps-elsewhere` starts with
 * `/var/lib/t3-environment/apps`, so a bare `startsWith` puts a stranger's
 * directory inside our deploy root. Membership is `=== root` or
 * `startsWith(root + "/")`, never the prefix alone.
 *
 * Fail-closed on anything unresolved. A caller who passes the path as typed —
 * with a `..` in it, or relative — gets `false` rather than a comparison
 * against a string that does not describe a real location. The question this
 * answers is only meaningful about a path with the symlinks already followed,
 * and a function that answered it anyway would be answering a different one.
 */
export function unitPathIsContained(root: string, resolved: string): boolean {
  if (!root.startsWith("/") || !resolved.startsWith("/")) return false;
  if (root.endsWith("/") && root !== "/") return false;
  if (resolved.split("/").includes("..") || resolved.split("/").includes(".")) return false;
  return resolved === root || resolved.startsWith(`${root}/`);
}

// ── the rule ─────────────────────────────────────────────────────────────────

/**
 * Whether the helper may be asked this, and with what.
 *
 * Everything here is a statement about the request, never about the machine:
 * whether the unit exists, whether T3 wrote it, and where a path actually
 * resolves are all facts only the box holds, and the helper checks every one of
 * them again before it acts. A decision that tried to pre-empt those would be
 * deciding from a stale copy of somebody else's filesystem.
 */
export function decideUnitCommand(request: UnitRequest): UnitCommandDecision {
  if (!(UNIT_VERBS as ReadonlyArray<string>).includes(request.verb)) {
    return refuse(
      "unknown-verb",
      `"${String(request.verb)}" is not something the helper does.`,
      `It knows ${UNIT_VERBS.join(", ")} and nothing else. Anything beyond that is an ordinary command, which you already have a shell for.`,
    );
  }

  // Not trimmed. A name with a space around it is refused rather than repaired,
  // because the helper does not trim either and two copies of a rule that
  // disagree about which strings are the same unit is how one of them ends up
  // checking a name the other did not act on.
  const name = canonicaliseUnitName(request.name);
  const nameRefusal = checkName(name);
  if (nameRefusal !== null) {
    return { outcome: "refuse", refusal: nameRefusal };
  }

  if (request.verb !== "create") {
    return {
      outcome: "allow",
      plan: { verb: request.verb, name, create: null, needsBindCapability: false },
    };
  }

  const fields = request.create;

  if (fields.exec.trim().length === 0) {
    return refuse(
      "exec-missing",
      "Creating a unit needs a program to run.",
      `Point \`--exec\` at an executable inside ${UNIT_DEPLOY_ROOT}.`,
    );
  }

  const execRefusal = checkPath(fields.exec, "The program path");
  if (execRefusal !== null) return { outcome: "refuse", refusal: execRefusal };

  if (fields.workingDirectory !== null) {
    const dirRefusal = checkPath(fields.workingDirectory, "The working directory");
    if (dirRefusal !== null) return { outcome: "refuse", refusal: dirRefusal };
  }

  if (fields.args.length > UNIT_ARG_COUNT_MAX) {
    return refuse(
      "too-many-arguments",
      `A unit may carry at most ${UNIT_ARG_COUNT_MAX} arguments; this one has ${fields.args.length}.`,
      "A program that needs more than that wants a config file in its deploy directory.",
    );
  }

  for (const argument of fields.args) {
    if (argument.length > UNIT_ARG_MAX) {
      return refuse(
        "argument-too-long",
        `An argument may be at most ${UNIT_ARG_MAX} characters.`,
        "Put the long value in a file and pass the path.",
      );
    }
    // The strictest rule in the file, and the one that is load-bearing. The
    // helper writes these into a unit file line by line; a newline here would
    // let the caller add its own directives to a file root is writing, and
    // `User=root` is one line. Whitespace is out for the same reason quoting
    // rules in a generated unit are not worth auditing, and `%` is a systemd
    // specifier that expands to something the caller did not type.
    if (!ARGUMENT_PATTERN.test(argument)) {
      return refuse(
        "argument-malformed",
        `"${argument.slice(0, 40)}" cannot be an argument to a generated unit.`,
        "Arguments hold letters, digits and `._/:=,@+-`: no whitespace, no newlines, no percent signs. Anything wordier belongs in a config file inside the deploy root.",
      );
    }
  }

  if (fields.description !== null) {
    if (fields.description.length > UNIT_DESCRIPTION_MAX) {
      return refuse(
        "description-malformed",
        `A description may be at most ${UNIT_DESCRIPTION_MAX} characters.`,
        "It is one line in `systemctl status`, not documentation.",
      );
    }
    if (!DESCRIPTION_PATTERN.test(fields.description)) {
      return refuse(
        "description-malformed",
        "That description cannot go into a unit file.",
        "One line of ordinary text: letters, digits, spaces and `._,:/()-`.",
      );
    }
  }

  if (fields.port !== null) {
    if (!Number.isInteger(fields.port) || fields.port < MIN_PORT || fields.port > MAX_PORT) {
      return refuse(
        "port-out-of-range",
        `${fields.port} is not a port.`,
        `Ports run from ${MIN_PORT} to ${MAX_PORT}.`,
      );
    }
  }

  return {
    outcome: "allow",
    plan: {
      verb: "create",
      name,
      create: {
        exec: fields.exec,
        args: [...fields.args],
        workingDirectory: fields.workingDirectory,
        port: fields.port,
        description: fields.description,
      },
      // A low port is a capability on the unit and never a uid on the process.
      // Running the app as root to bind 80 is the shortcut this refuses to take.
      needsBindCapability: fields.port !== null && fields.port < UNIT_PRIVILEGED_PORT_CEILING,
    },
  };
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * The argument vector, as a vector.
 *
 * Built as a list because that is what it is. The one seam that takes a string
 * — `BoxSession.exec`, which hands a command line to a shell on the box — gets
 * one assembled from this by `unitHelperCommandLine`, and every element in it
 * has already been through an allowlist that excludes every character a shell
 * would treat as anything.
 */
export function unitHelperArgv(plan: UnitPlan): ReadonlyArray<string> {
  const argv: Array<string> = ["sudo", "-n", UNIT_HELPER_PATH, plan.verb, plan.name];
  if (plan.create === null) return argv;

  argv.push("--exec", plan.create.exec);
  for (const argument of plan.create.args) argv.push("--arg", argument);
  if (plan.create.workingDirectory !== null) {
    argv.push("--working-dir", plan.create.workingDirectory);
  }
  if (plan.create.port !== null) argv.push("--port", String(plan.create.port));
  if (plan.create.description !== null) argv.push("--description", plan.create.description);
  return argv;
}

/**
 * POSIX single-quoting, applied to values that already cannot need it.
 *
 * Belt and braces on purpose: the allowlists mean nothing reaching here holds a
 * quote, a space or a metacharacter, so this changes nothing today. It is here
 * for the day somebody widens an allowlist and does not think about this file —
 * a quoting function that was never written is the one that is missing then.
 */
export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function unitHelperCommandLine(plan: UnitPlan): string {
  return unitHelperArgv(plan).map(quoteShellArgument).join(" ");
}

/**
 * The helper's own refusal, read back off stderr.
 *
 * The helper decides again on the box and can refuse something this module
 * allowed — a unit it did not write, a symlink out of the deploy root, a
 * deploy root that is not there. Those refusals are journalled as refusals
 * rather than as command failures, because that is what they are, and a table
 * where the box's own refusals appear as `exit 3` would hide the most
 * interesting rows in it.
 */
export function parseHelperRefusal(text: string): string | null {
  const match = /refused \(([a-z-]+)\)/.exec(text);
  return match?.[1] ?? null;
}
