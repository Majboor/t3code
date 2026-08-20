#!/bin/sh
# The only privileged thing the T3 agent may do on a box, and nothing else.
#
# The agent runs as an unprivileged service user with an ordinary shell, which
# means it can already do everything that user can do. What it cannot do — and
# must not be given — is root. `NOPASSWD: /bin/systemctl` would hand it exactly
# that: the machine runs other people's production services, and one
# `systemctl stop days-tracker-api` is the mistake that is never forgiven.
#
# So the sudoers rule names *this file* and no other, and this file has a fixed
# vocabulary of seven verbs over units it wrote itself. Everything a caller
# supplies is validated against an allowlist before anything happens, and the
# unit file is generated here from a template rather than accepted from the
# caller — an ExecStart the agent could dictate is arbitrary code as root, which
# is the whole thing this exists to prevent. Even a permitted unit is pinned to
# `User=$T3_SERVICE_USER`, so the worst case is the agent running as itself,
# which it could already do.
#
# The rules that keep it narrow:
#
#   * Nothing is `eval`-ed and nothing is passed to `sh -c`. Every external
#     command is invoked with an argument vector, so a value that reached here
#     is a value, never a fragment of a command line.
#   * Unit names are matched against an allowlist after canonicalising, not
#     tested with a string prefix. `t3-app-../other` has the right prefix and is
#     refused, because the characters in it are not in the allowlist at all.
#   * Path arguments must resolve — after symlinks — inside the agent's own
#     deploy root. A symlink out of that root resolves out of it and is refused.
#   * Arguments carry no whitespace, no newlines and no `%`. A newline in an
#     argument would let a caller append `User=root` to the generated unit, and
#     `%` is a systemd specifier.
#   * Refusals are audited exactly like actions. The refusal is the interesting
#     line in the log.
#
# Validation happens before the root check on purpose, so the argument rules can
# be exercised by the test suite on any machine without a privileged shell.
#
# Deliberately out of scope: installing packages. This never runs a package
# manager, and an agent that needs one has to ask the person who owns the box.

set -eu

# Byte semantics for every pattern below. Without this, `[a-z]` follows the
# machine's collation, and the allowlists that stop unicode lookalikes become a
# property of the box's locale rather than of this file.
LC_ALL=C
export LC_ALL

# A PATH we chose. sudo resets the environment, but this script is also
# runnable directly by root, and inheriting a PATH is how a helper ends up
# running somebody else's `systemctl`.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# --- drift-checked constants ---
# Plain NAME="value" lines, no expansion, because decideUnitCommand.test.ts
# parses this block as text and asserts it agrees with the TypeScript copy of
# the same rules. If you change a value here, that test tells you about the
# other copy.
T3_UNIT_PREFIX="t3-app-"
T3_UNIT_SUFFIX=".service"
T3_UNIT_MARKER="# Managed by t3-unit-helper"
T3_UNIT_DIR="/etc/systemd/system"
T3_SERVICE_USER="t3env"
T3_DEPLOY_ROOT="/var/lib/t3-environment/apps"
T3_HELPER_PATH="/opt/t3-environment/libexec/t3-unit-helper"
T3_SUDOERS_PATH="/etc/sudoers.d/t3-environment"
T3_AUDIT_LOG="/var/log/t3-unit-helper.log"
T3_VERBS="create start stop restart enable disable status"
T3_NAME_MAX="64"
T3_ARG_MAX="512"
T3_ARG_COUNT_MAX="32"
T3_DESCRIPTION_MAX="200"
T3_PRIVILEGED_PORT_CEILING="1024"
T3_EXIT_REFUSED="3"
T3_EXIT_USAGE="2"
# --- end drift-checked constants ---

# The allowlists, spelled once. Every one of them is a `tr -d` set: a value is
# clean when deleting all the permitted characters leaves nothing behind.
T3_NAME_CHARS="a-z0-9-"
T3_PATH_CHARS="A-Za-z0-9._/-"
T3_ARG_CHARS="A-Za-z0-9._/:=,@+-"
T3_DESCRIPTION_CHARS="A-Za-z0-9._,:/() -"
T3_AUDIT_CHARS="A-Za-z0-9._/:=,@+ -"

# Literal control characters, built rather than typed, so this file stays
# copy-pasteable and greppable.
T3_NL="$(printf '\n_')"
T3_NL="${T3_NL%_}"
T3_CR="$(printf '\r_')"
T3_CR="${T3_CR%_}"
T3_TAB="$(printf '\t_')"
T3_TAB="${T3_TAB%_}"

# --- output ----------------------------------------------------------------
log() { printf 't3-unit-helper: %s\n' "$*" >&2; }

# A failure: something was permitted and did not work.
die() {
  audit "$T3_AUDIT_VERB" "$T3_AUDIT_UNIT" failed "$*"
  printf 't3-unit-helper: ERROR: %s\n' "$*" >&2
  exit 1
}

# A refusal: the request was understood and is not allowed. Its own exit code
# and a machine-readable reason, because the caller journals refusals
# separately from failures — a refusal is a decision, not a fault.
refuse() {
  refuse_reason="$1"
  shift
  audit "$T3_AUDIT_VERB" "$T3_AUDIT_UNIT" "refused:$refuse_reason" "$*"
  printf 't3-unit-helper: refused (%s): %s\n' "$refuse_reason" "$*" >&2
  exit "$T3_EXIT_REFUSED"
}

usage() {
  cat <<EOF
Manage the systemd units the T3 agent owns, and nothing else.

Usage:
  t3-unit-helper create <name> --exec <path> [--arg <value>]... [options]
  t3-unit-helper start|stop|restart|enable|disable|status <name>

Names must be ${T3_UNIT_PREFIX}<something>${T3_UNIT_SUFFIX}: lowercase letters, digits
and dashes, at most $T3_NAME_MAX characters. Every other verb only acts on a unit
carrying this helper's marker, so a unit somebody else wrote is refused even
if it is named to look like ours.

create options:
  --exec <path>          The program to run. Must resolve inside
                         $T3_DEPLOY_ROOT and be executable.
  --arg <value>          One argument for it. Repeatable, at most $T3_ARG_COUNT_MAX.
                         No whitespace: put anything wordy in a config file.
  --working-dir <path>   Must resolve inside $T3_DEPLOY_ROOT.
                         Defaults to the directory holding --exec.
  --port <number>        Sets PORT= in the unit. Below $T3_PRIVILEGED_PORT_CEILING this also grants
                         CAP_NET_BIND_SERVICE, which is how a low port is bound
                         without running anything as root.
  --description <text>   One line, for \`systemctl status\`.

Never does: run a package manager, accept unit-file content, touch a unit it
did not write, or run anything as root. Generated units run as $T3_SERVICE_USER.
EOF
}

# --- audit -----------------------------------------------------------------
# Every invocation lands here exactly once, including the ones that refused.
# The log is root-owned and outside the agent's reach on purpose: an audit trail
# the audited party can rewrite is not one.
#
# Fields are scrubbed to a printable allowlist first. The unit name in a refusal
# is by definition attacker-controlled — that is why it was refused — and a
# newline in it would otherwise forge a second log line.
T3_AUDIT_VERB="none"
T3_AUDIT_UNIT="none"
T3_AUDITED=0

scrub() {
  printf '%s' "$1" | tr -c "$T3_AUDIT_CHARS" '?' | cut -c1-200
}

audit() {
  [ "$T3_AUDITED" -eq 0 ] || return 0
  T3_AUDITED=1
  audit_line="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf 'unknown-time') verb=$(scrub "$1") unit=$(scrub "$2") outcome=$(scrub "$3") detail=$(scrub "$4") invoker=$(scrub "${SUDO_USER:-${USER:-unknown}}") invoker_uid=$(scrub "${SUDO_UID:-unknown}")"

  # Best effort, both ways, and neither may fail the command. syslog is where
  # an operator looks; the file is what survives a box with no syslog daemon.
  if command -v logger >/dev/null 2>&1; then
    logger -t t3-unit-helper -p auth.notice -- "$audit_line" 2>/dev/null || true
  fi
  if [ "$(id -u)" -eq 0 ]; then
    (
      umask 077
      printf '%s\n' "$audit_line" >>"$T3_AUDIT_LOG"
    ) 2>/dev/null || true
  fi
}

# --- validation ------------------------------------------------------------
# Clean means: no control characters, and nothing outside the allowlist. Written
# as "delete everything permitted and see if anything is left" so that the rule
# is one string per value kind rather than a regular expression nobody re-reads.
#
# The newline check is separate and comes first because command substitution
# strips trailing newlines: a value ending in one would survive the tr test and
# then append a line to a generated unit file.
value_is_clean() {
  case "$1" in
    *"$T3_NL"* | *"$T3_CR"* | *"$T3_TAB"*) return 1 ;;
  esac
  [ -z "$(printf '%s' "$1" | tr -d "$2")" ]
}

# A unit name, canonicalised then matched — never merely prefix-tested.
#
# `t3-app-../other.service` passes any string-prefix check ever written, which
# is why there is not one here: the stem between the prefix and the suffix has
# to be lowercase alphanumerics and dashes and nothing else, so traversal,
# metacharacters, `@` instances and unicode lookalikes are all refused by the
# same rule without any of them needing to be anticipated.
canonicalise_unit_name() {
  canonical_value="$1"
  case "$canonical_value" in
    *"$T3_UNIT_SUFFIX") ;;
    *) canonical_value="$canonical_value$T3_UNIT_SUFFIX" ;;
  esac
  printf '%s' "$canonical_value"
}

validate_unit_name() {
  validate_name="$1"

  [ -n "$validate_name" ] || refuse unit-name-empty "no unit was named."
  [ "${#validate_name}" -le "$T3_NAME_MAX" ] ||
    refuse unit-name-too-long "a unit name may be at most $T3_NAME_MAX characters; that one is ${#validate_name}."

  case "$validate_name" in
    "$T3_UNIT_PREFIX"*"$T3_UNIT_SUFFIX") ;;
    *)
      refuse unit-name-outside-prefix \
        "this helper only manages units named ${T3_UNIT_PREFIX}<something>${T3_UNIT_SUFFIX}. Everything else on this machine belongs to somebody else."
      ;;
  esac

  validate_stem="${validate_name#"$T3_UNIT_PREFIX"}"
  validate_stem="${validate_stem%"$T3_UNIT_SUFFIX"}"

  [ -n "$validate_stem" ] ||
    refuse unit-name-malformed "\"$T3_UNIT_PREFIX$T3_UNIT_SUFFIX\" names nothing."

  value_is_clean "$validate_stem" "$T3_NAME_CHARS" ||
    refuse unit-name-malformed \
      "a unit name may hold only lowercase letters, digits and dashes after \"$T3_UNIT_PREFIX\"."

  # A leading or trailing dash is not dangerous, it is ambiguous — and a name
  # starting with one is an argument that looks like a flag to everything it is
  # ever passed to.
  case "$validate_stem" in
    -* | *-) refuse unit-name-malformed "a unit name may not start or end with a dash." ;;
  esac
}

validate_path_syntax() {
  validate_path_value="$1"
  validate_path_label="$2"

  [ -n "$validate_path_value" ] || refuse path-not-absolute "$validate_path_label was empty."

  case "$validate_path_value" in
    /*) ;;
    *) refuse path-not-absolute "$validate_path_label must be an absolute path; got \"$validate_path_value\"." ;;
  esac

  value_is_clean "$validate_path_value" "$T3_PATH_CHARS" ||
    refuse path-malformed "$validate_path_label holds characters a path here may not: only letters, digits, dot, dash, underscore and slash."

  # Rejected on syntax as well as on resolution. Resolution is the check that
  # matters, and this one makes the refusal say something true about the input
  # rather than about the directory it happened to land in.
  case "$validate_path_value" in
    */../* | */.. | ../* | ..)
      refuse path-traversal "$validate_path_label walks upwards with \"..\", which is never how a path inside the deploy root is written."
      ;;
  esac
}

# --- filesystem ------------------------------------------------------------
# Everything below here needs root and a real machine.

require_root() {
  [ "$(id -u)" -eq 0 ] ||
    die "this must run as root, through the single sudoers rule at $T3_SUDOERS_PATH."
}

resolve_path() {
  # `-e` and `-f` both mean "the path must exist" for the tool that has them.
  # An unresolvable path is refused rather than resolved optimistically: the
  # question here is what a symlink points at, and a path that does not exist
  # has no answer.
  if command -v realpath >/dev/null 2>&1; then
    realpath -e -- "$1" 2>/dev/null || printf ''
  else
    readlink -f -- "$1" 2>/dev/null || printf ''
  fi
}

# The deploy root has to be a real directory at the literal path, not a symlink
# to one.
#
# The agent owns its data directory, so it can delete `apps` and put a symlink
# to `/` in its place. Resolving the root before comparing would then make every
# path on the machine "inside the deploy root" — the containment check would
# still pass and would mean nothing.
require_deploy_root() {
  [ -e "$T3_DEPLOY_ROOT" ] ||
    refuse deploy-root-missing "$T3_DEPLOY_ROOT does not exist, so nothing can be deployed from it yet."
  [ ! -L "$T3_DEPLOY_ROOT" ] ||
    refuse deploy-root-unsafe "$T3_DEPLOY_ROOT is a symlink. It must be a real directory: a link there would make every path on this machine look like it was inside the deploy root."
  [ -d "$T3_DEPLOY_ROOT" ] ||
    refuse deploy-root-unsafe "$T3_DEPLOY_ROOT is not a directory."
  [ "$(resolve_path "$T3_DEPLOY_ROOT")" = "$T3_DEPLOY_ROOT" ] ||
    refuse deploy-root-unsafe "$T3_DEPLOY_ROOT resolves somewhere else, so it is not the directory this helper was installed to trust."
}

# Containment, decided on the resolved path and never on the given one.
#
# The trailing slash in the second pattern is the whole check: without it,
# `/var/lib/t3-environment/apps-elsewhere` is a prefix match and a stranger's
# directory becomes ours.
#
# The answer comes back in a global rather than on stdout, because a refusal has
# to end the program. A function that printed its result would be called in a
# command substitution, `refuse` would exit that subshell, and whether the
# parent stopped would depend on `set -e` still being in force at the call site
# — which is not a property a permission check should rest on.
T3_RESOLVED=""
require_inside_deploy_root() {
  inside_given="$1"
  inside_label="$2"

  inside_resolved="$(resolve_path "$inside_given")"
  [ -n "$inside_resolved" ] ||
    refuse path-not-found "$inside_label ($inside_given) does not exist on this machine."

  case "$inside_resolved" in
    "$T3_DEPLOY_ROOT" | "$T3_DEPLOY_ROOT"/*) ;;
    *)
      refuse path-outside-deploy-root \
        "$inside_label resolves to $inside_resolved, which is outside $T3_DEPLOY_ROOT. Symlinks are followed before this is decided, so a link out of the deploy root leads out of it."
      ;;
  esac

  T3_RESOLVED="$inside_resolved"
}

unit_path_of() { printf '%s/%s' "$T3_UNIT_DIR" "$1"; }

# True only for a unit this helper wrote. The name allowlist says a caller may
# only *ask* about `t3-app-…`; this says the file also has to be ours. A unit
# somebody hand-wrote under a name in our range is somebody else's unit, and
# stopping it because it was named to look like ours is the failure in miniature.
unit_is_ours() {
  unit_is_ours_path="$(unit_path_of "$1")"
  [ -f "$unit_is_ours_path" ] &&
    head -n 1 "$unit_is_ours_path" 2>/dev/null | grep -qxF "$T3_UNIT_MARKER"
}

require_our_unit() {
  require_our_path="$(unit_path_of "$1")"
  if [ ! -e "$require_our_path" ]; then
    refuse unit-not-found "there is no unit at $require_our_path. \`create\` writes one; this helper will not act on a unit it did not write."
  fi
  unit_is_ours "$1" ||
    refuse unit-not-ours "$require_our_path exists and was not written by this helper. Nothing here knows what depends on it — leave it alone and ask the person who owns this machine."
}

find_systemctl() {
  # Absolute candidates only. Looking it up on PATH would make which binary runs
  # as root a function of the environment, which is the environment of whoever
  # called sudo.
  for find_systemctl_candidate in /usr/bin/systemctl /bin/systemctl /usr/sbin/systemctl /sbin/systemctl; do
    if [ -x "$find_systemctl_candidate" ]; then
      printf '%s' "$find_systemctl_candidate"
      return 0
    fi
  done
  printf ''
}

# --- verbs -----------------------------------------------------------------
write_unit() {
  write_unit_name="$1"
  write_unit_exec="$2"
  write_unit_dir="$3"
  write_unit_port="$4"
  write_unit_description="$5"
  write_unit_args="$6"

  write_unit_path="$(unit_path_of "$write_unit_name")"

  # A low port gets a capability, never a uid. `User=` stays the unprivileged
  # service user and systemd hands the process the one capability it needs to
  # bind below 1024 — which is the whole reason nothing here ever runs as root.
  write_unit_caps="CapabilityBoundingSet="
  if [ -n "$write_unit_port" ] && [ "$write_unit_port" -lt "$T3_PRIVILEGED_PORT_CEILING" ]; then
    write_unit_caps="AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
  fi

  write_unit_env=""
  if [ -n "$write_unit_port" ]; then
    write_unit_env="Environment=PORT=$write_unit_port"
  fi

  # Written beside the target and moved into place, so a unit file is never
  # half-written while systemd is reading it.
  write_unit_tmp="$write_unit_path.t3new"
  cat >"$write_unit_tmp" <<EOF
$T3_UNIT_MARKER
# Generated by $T3_HELPER_PATH from a fixed template. Edits are lost the next
# time this unit is created, and nothing here came from the caller except the
# values in ExecStart, WorkingDirectory, PORT and Description — each of which
# was checked against an allowlist first.

[Unit]
Description=$write_unit_description
After=network-online.target
Wants=network-online.target
ConditionPathIsDirectory=$write_unit_dir
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$T3_SERVICE_USER
Group=$T3_SERVICE_USER
WorkingDirectory=$write_unit_dir
$write_unit_env

ExecStart=$write_unit_exec$write_unit_args

Restart=on-failure
RestartSec=5s

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ReadWritePaths=$T3_DEPLOY_ROOT
$write_unit_caps
UMask=0077
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
EOF

  chmod 0644 "$write_unit_tmp"
  chown root:root "$write_unit_tmp"
  mv -f "$write_unit_tmp" "$write_unit_path"
}

do_create() {
  create_name="$1"
  shift

  create_exec=""
  create_dir=""
  create_port=""
  create_description=""
  create_args=""
  create_arg_count=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --exec)
        [ $# -ge 2 ] || refuse missing-value "--exec needs a path."
        create_exec="$2"
        shift 2
        ;;
      --arg)
        [ $# -ge 2 ] || refuse missing-value "--arg needs a value."
        create_arg_count=$((create_arg_count + 1))
        [ "$create_arg_count" -le "$T3_ARG_COUNT_MAX" ] ||
          refuse too-many-arguments "at most $T3_ARG_COUNT_MAX arguments; a program needing more wants a config file."
        [ "${#2}" -le "$T3_ARG_MAX" ] ||
          refuse argument-too-long "an argument may be at most $T3_ARG_MAX characters."
        # The rule that stops unit-file injection. A newline here would let a
        # caller write its own `User=root` line into the generated unit; `%` is
        # a systemd specifier; whitespace would need quoting rules nobody
        # should have to audit.
        value_is_clean "$2" "$T3_ARG_CHARS" ||
          refuse argument-malformed \
            "an argument may hold only letters, digits and ._/:=,@+- — no whitespace, no newlines, no percent signs. Put anything wordier in a config file inside the deploy root."
        create_args="$create_args $2"
        shift 2
        ;;
      --working-dir)
        [ $# -ge 2 ] || refuse missing-value "--working-dir needs a path."
        create_dir="$2"
        shift 2
        ;;
      --port)
        [ $# -ge 2 ] || refuse missing-value "--port needs a number."
        create_port="$2"
        shift 2
        ;;
      --description)
        [ $# -ge 2 ] || refuse missing-value "--description needs some text."
        create_description="$2"
        shift 2
        ;;
      *)
        refuse unknown-option "\"$1\" is not an option this helper takes."
        ;;
    esac
  done

  [ -n "$create_exec" ] || refuse exec-missing "create needs --exec: the program the unit should run."
  validate_path_syntax "$create_exec" "--exec"
  if [ -n "$create_dir" ]; then
    validate_path_syntax "$create_dir" "--working-dir"
  fi

  if [ -n "$create_port" ]; then
    case "$create_port" in
      '' | *[!0-9]*) refuse port-out-of-range "--port must be a number; got \"$create_port\"." ;;
    esac
    [ "${#create_port}" -le 5 ] || refuse port-out-of-range "--port must be between 1 and 65535."
    { [ "$create_port" -ge 1 ] && [ "$create_port" -le 65535 ]; } ||
      refuse port-out-of-range "--port must be between 1 and 65535; got $create_port."
  fi

  if [ -n "$create_description" ]; then
    [ "${#create_description}" -le "$T3_DESCRIPTION_MAX" ] ||
      refuse description-malformed "--description may be at most $T3_DESCRIPTION_MAX characters."
    value_is_clean "$create_description" "$T3_DESCRIPTION_CHARS" ||
      refuse description-malformed "--description must be one line of ordinary text: letters, digits, spaces and ._,:/()- only."
  else
    create_description="T3 app $create_name"
  fi

  require_root
  require_deploy_root

  require_inside_deploy_root "$create_exec" "--exec"
  create_resolved_exec="$T3_RESOLVED"
  [ -f "$create_resolved_exec" ] ||
    refuse exec-not-a-file "--exec resolves to $create_resolved_exec, which is not a regular file."
  [ -x "$create_resolved_exec" ] ||
    refuse exec-not-executable "$create_resolved_exec is not executable. chmod +x it as the service user."
  # Neither can escalate anything — the generated unit sets NoNewPrivileges —
  # but a setuid binary as an ExecStart is a thing nobody meant to ask for.
  { [ ! -u "$create_resolved_exec" ] && [ ! -g "$create_resolved_exec" ]; } ||
    refuse exec-setuid "$create_resolved_exec is setuid or setgid, and this helper will not put one in a unit."

  if [ -n "$create_dir" ]; then
    require_inside_deploy_root "$create_dir" "--working-dir"
    create_resolved_dir="$T3_RESOLVED"
    [ -d "$create_resolved_dir" ] ||
      refuse working-dir-not-a-directory "--working-dir resolves to $create_resolved_dir, which is not a directory."
  else
    create_resolved_dir="${create_resolved_exec%/*}"
    [ -n "$create_resolved_dir" ] || create_resolved_dir="$T3_DEPLOY_ROOT"
  fi

  # An existing unit in our name range that we did not write is somebody else's
  # file. Overwriting it would be the escalation this helper exists to refuse,
  # dressed up as a create.
  create_path="$(unit_path_of "$create_name")"
  if [ -e "$create_path" ] && ! unit_is_ours "$create_name"; then
    refuse unit-not-ours "$create_path already exists and was not written by this helper. Refusing to overwrite it."
  fi

  create_systemctl="$(find_systemctl)"
  [ -n "$create_systemctl" ] || die "systemctl was not found at any of the usual paths."

  write_unit "$create_name" "$create_resolved_exec" "$create_resolved_dir" \
    "$create_port" "$create_description" "$create_args"
  "$create_systemctl" daemon-reload || die "systemctl daemon-reload failed after writing $create_path."

  audit create "$create_name" ok "exec=$create_resolved_exec dir=$create_resolved_dir port=${create_port:-none}"
  log "wrote $create_path, running as $T3_SERVICE_USER"
  printf '%s\n' "$create_path"
}

do_lifecycle() {
  lifecycle_verb="$1"
  lifecycle_name="$2"

  require_root
  require_our_unit "$lifecycle_name"

  lifecycle_systemctl="$(find_systemctl)"
  [ -n "$lifecycle_systemctl" ] || die "systemctl was not found at any of the usual paths."

  case "$lifecycle_verb" in
    status)
      # Not a failure when the unit is stopped: "it is not running" is the
      # answer to the question, and an exit code that says otherwise would send
      # a caller looking for a fault that is not there.
      lifecycle_output="$("$lifecycle_systemctl" status --no-pager --full --lines 20 -- "$lifecycle_name" 2>&1 || true)"
      audit status "$lifecycle_name" ok "reported"
      printf '%s\n' "$lifecycle_output"
      ;;
    enable | disable)
      "$lifecycle_systemctl" "$lifecycle_verb" -- "$lifecycle_name" ||
        die "systemctl $lifecycle_verb failed for $lifecycle_name."
      audit "$lifecycle_verb" "$lifecycle_name" ok "at boot"
      log "$lifecycle_verb""d $lifecycle_name at boot"
      ;;
    *)
      "$lifecycle_systemctl" "$lifecycle_verb" -- "$lifecycle_name" ||
        die "systemctl $lifecycle_verb failed for $lifecycle_name."
      audit "$lifecycle_verb" "$lifecycle_name" ok "done"
      log "$lifecycle_verb $lifecycle_name"
      ;;
  esac
}

# --- entry -----------------------------------------------------------------
if [ $# -eq 0 ]; then
  usage
  exit "$T3_EXIT_USAGE"
fi

case "$1" in
  -h | --help)
    usage
    exit 0
    ;;
esac

verb="$1"
shift

# The vocabulary is fixed and closed. A verb that is not on this list is not a
# verb this helper has, whatever systemctl might make of it.
verb_known=0
for known in $T3_VERBS; do
  if [ "$verb" = "$known" ]; then
    verb_known=1
    break
  fi
done
T3_AUDIT_VERB="$verb"
[ "$verb_known" -eq 1 ] ||
  refuse unknown-verb "\"$verb\" is not one of: $T3_VERBS."

[ $# -ge 1 ] || refuse unit-name-empty "$verb needs a unit name."
name="$(canonicalise_unit_name "$1")"
shift
T3_AUDIT_UNIT="$name"
validate_unit_name "$name"

if [ "$verb" = "create" ]; then
  do_create "$name" "$@"
else
  [ $# -eq 0 ] || refuse unknown-option "$verb takes a unit name and nothing else."
  do_lifecycle "$verb" "$name"
fi
