#!/usr/bin/env bash
# Reads a `.pack` directory's manifest and turns it into deploy decisions.
#
# Sourced, never executed directly. This is the layer docs/deployment.md called
# the prerequisite for everything above tier 1: the runner used to take a
# directory and a `--command`, so it had no packId, no declared surface, no
# permissions and nothing to attribute an event to. Everything the deploy needs
# is derived here from `runtime`, `interfaces`, `permissions` and `requirements`
# instead of being restated on the command line.
#
# The other half of its job is refusal. A manifest declares what a pack is
# allowed to do; if this host cannot honour a declaration, deploying anyway
# would run the pack with weaker guarantees than its own manifest claims, and
# the deployment's telemetry would then be attributed to a configuration nobody
# declared. So an unhonourable declaration is a failed deploy with a message
# naming the field, not a warning nobody reads.

set -euo pipefail

[[ -n "${LP_PACK_SOURCED-}" ]] && return 0
LP_PACK_SOURCED=1

lp_pack_common_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../host/lp-common.sh
source "${lp_pack_common_dir}/../host/lp-common.sh"

# The only format version this runner understands. `1.0` is readable by a
# migrator and rejected here, because in `1.0` the `verification` section meant
# a reviewer's badge rather than production behaviour — a reader that treated
# one as the other would misattribute every signal it collected.
readonly LP_PACK_SUPPORTED_FORMAT_VERSION="2.0"
readonly LP_PACK_MANIFEST_FILENAME="pack.json"

# Populated by lp_pack_load.
LP_PACK_DIR=""
LP_PACK_ID=""
LP_PACK_NAME=""
LP_PACK_VERSION=""
LP_PACK_FORMAT_VERSION=""
LP_PACK_VISIBILITY=""
LP_PACK_TARGET=""
LP_PACK_VERSION_RANGE=""
LP_PACK_START_COMMAND=""
LP_PACK_START_CWD=""
LP_PACK_SERVICE_ID=""
LP_PACK_SERVICE_EXPLICIT="no"
LP_PACK_SERVICE_COUNT="0"
LP_PACK_PORT_BINDING=""
LP_PACK_PORT_ENV_VAR=""
LP_PACK_FIXED_PORT=""
LP_PACK_HEALTH_PATH=""
LP_PACK_EXPOSURE=""
LP_PACK_CONTENT_DIGEST=""
LP_PACK_DERIVED_FROM_JSON="null"
LP_PACK_RUNTIME_VERSION="unknown"
LP_PACK_PORTS_DECLARED="no"
declare -a LP_PACK_HOSTS=()
declare -a LP_PACK_REQUIRED_ENV=()
declare -a LP_PACK_ACCOUNTS=()
declare -a LP_PACK_PROBLEMS=()

lp_pack_manifest() { printf '%s/%s' "${LP_PACK_DIR}" "${LP_PACK_MANIFEST_FILENAME}"; }

# All manifest reads go through one place so that a missing field is always the
# empty string and never the literal "null" leaking into a shell comparison.
lp_pack_query() {
  local query="$1"
  jq -r "${query} // \"\" | if type == \"array\" or type == \"object\" then tojson else . end" \
    "$(lp_pack_manifest)" 2>/dev/null || printf ''
}

lp_pack_query_json() {
  local query="$1"
  jq -c "${query}" "$(lp_pack_manifest)" 2>/dev/null || printf 'null'
}

# The bytes that actually ran, which is what every event is attributed by.
# Computed over the file list and its contents together, so a rename with no
# content change still moves the digest.
lp_pack_content_digest() {
  local dir="$1"
  (
    cd -- "${dir}" || exit 1
    find . -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | awk '{print $1}'
  )
}

lp_pack_problem() { LP_PACK_PROBLEMS+=("$1"); }

lp_pack_detected_runtime_version() {
  local target="$1"
  case "${target}" in
    node) node --version 2>/dev/null | sed 's/^v//' ;;
    bun) bun --version 2>/dev/null ;;
    deno) deno --version 2>/dev/null | awk 'NR==1 {print $2}' ;;
    python) python3 --version 2>/dev/null | awk '{print $2}' ;;
    *) printf '' ;;
  esac
}

# Deliberately narrow. A full semver range solver in shell would be a liability,
# so only the ">=X[.Y[.Z]]" form is actually checked and anything else is
# reported as unverified rather than quietly treated as satisfied.
lp_pack_version_satisfies() {
  local range="$1" actual="$2" want_major want_minor have_major have_minor

  [[ -n "${range}" ]] || return 0
  [[ "${range}" =~ ^\>=[[:space:]]*([0-9]+)(\.([0-9]+))?.*$ ]] || return 2

  want_major="${BASH_REMATCH[1]}"
  want_minor="${BASH_REMATCH[3]:-0}"
  have_major="${actual%%.*}"
  have_minor="${actual#*.}"
  have_minor="${have_minor%%.*}"
  [[ "${have_major}" =~ ^[0-9]+$ ]] || return 2
  [[ "${have_minor}" =~ ^[0-9]+$ ]] || have_minor=0

  (( have_major > want_major )) && return 0
  (( have_major == want_major && have_minor >= want_minor )) && return 0
  return 1
}

# Reads the manifest into the globals above. Does not judge it; lp_pack_check
# does that, so a caller can print a plan for a pack it is going to refuse.
lp_pack_load() {
  local dir="$1" service_json

  dir="$(cd -- "${dir}" 2>/dev/null && pwd)" || lp_die "--pack '${dir}' is not a readable directory"
  LP_PACK_DIR="${dir}"

  [[ -f "$(lp_pack_manifest)" ]] \
    || lp_die "no ${LP_PACK_MANIFEST_FILENAME} at the top of '${dir}': a pack is a directory whose manifest names everything else"

  jq -e . "$(lp_pack_manifest)" >/dev/null 2>&1 \
    || lp_die "$(lp_pack_manifest) is not valid JSON"

  LP_PACK_FORMAT_VERSION="$(lp_pack_query '.formatVersion')"
  LP_PACK_ID="$(lp_pack_query '.identity.id')"
  LP_PACK_NAME="$(lp_pack_query '.identity.name')"
  LP_PACK_VERSION="$(lp_pack_query '.identity.version')"
  LP_PACK_VISIBILITY="$(lp_pack_query '.visibility.scope')"
  LP_PACK_TARGET="$(lp_pack_query '.runtime.target')"
  LP_PACK_VERSION_RANGE="$(lp_pack_query '.runtime.versionRange')"
  LP_PACK_START_COMMAND="$(lp_pack_query '.runtime.commands.start.command')"
  LP_PACK_START_CWD="$(lp_pack_query '.runtime.commands.start.cwd')"
  LP_PACK_DERIVED_FROM_JSON="$(lp_pack_query_json '.provenance.derivedFrom // null')"
  LP_PACK_CONTENT_DIGEST="$(lp_pack_content_digest "${dir}")"
  LP_PACK_RUNTIME_VERSION="$(lp_pack_detected_runtime_version "${LP_PACK_TARGET}")"
  [[ -n "${LP_PACK_RUNTIME_VERSION}" ]] || LP_PACK_RUNTIME_VERSION="unknown"

  # One deployment gets one address and one port, so the service that owns them
  # has to be unambiguous. Picked here rather than guessed later.
  LP_PACK_SERVICE_COUNT="$(lp_pack_query '.runtime.services // [] | length')"
  if [[ "${LP_PACK_SERVICE_EXPLICIT}" == "yes" ]]; then
    service_json="$(lp_pack_query_json ".runtime.services // [] | map(select(.id == \"${LP_PACK_SERVICE_ID}\")) | .[0] // null")"
  else
    service_json="$(lp_pack_query_json '.runtime.services // [] | .[0] // null')"
  fi

  if [[ "${service_json}" != "null" && -n "${service_json}" ]]; then
    LP_PACK_SERVICE_ID="$(jq -r '.id // ""' <<<"${service_json}")"
    LP_PACK_PORT_BINDING="$(jq -r '.binding.type // ""' <<<"${service_json}")"
    LP_PACK_PORT_ENV_VAR="$(jq -r '.binding.envVar // ""' <<<"${service_json}")"
    LP_PACK_FIXED_PORT="$(jq -r '.binding.port // .binding.defaultPort // ""' <<<"${service_json}")"
    LP_PACK_HEALTH_PATH="$(jq -r '.healthPath // ""' <<<"${service_json}")"
    LP_PACK_EXPOSURE="$(jq -r '.exposure // ""' <<<"${service_json}")"
  fi

  mapfile -t LP_PACK_HOSTS < <(jq -r '.permissions.network // [] | .[].host' "$(lp_pack_manifest)" 2>/dev/null || true)
  mapfile -t LP_PACK_REQUIRED_ENV < <(
    jq -r '.requirements.environment // [] | map(select(.required)) | .[].name' "$(lp_pack_manifest)" 2>/dev/null || true
  )
  mapfile -t LP_PACK_ACCOUNTS < <(jq -r '.requirements.accounts // [] | .[].service' "$(lp_pack_manifest)" 2>/dev/null || true)

  LP_PACK_PORTS_DECLARED="$(
    jq -r 'if (.permissions.network // [] | map(.ports // []) | flatten | length) > 0 then "yes" else "no" end' \
      "$(lp_pack_manifest)" 2>/dev/null || printf 'no'
  )"
}

# Everything this host cannot honour, collected in one pass so an operator sees
# the whole list rather than fixing one field per failed deploy.
#
# `supplied_env_names` is the space-separated set of variables the operator
# passed in, because "a declared requirement was never supplied" is an install
# defect the contract classes as unrepairable — better refused at deploy time
# than emitted as a `config-missing` failure an hour later.
lp_pack_check() {
  local supplied_env_names="${1-}" egress_override="${2-}"
  local name host port_in_use elevated fs_root missing tool

  LP_PACK_PROBLEMS=()

  if [[ "${LP_PACK_FORMAT_VERSION}" != "${LP_PACK_SUPPORTED_FORMAT_VERSION}" ]]; then
    if [[ "${LP_PACK_FORMAT_VERSION}" == "1.0" ]]; then
      lp_pack_problem "formatVersion 1.0 is superseded: its 'verification' section meant a reviewer's badge, not production behaviour. Migrate the manifest to 2.0."
    else
      lp_pack_problem "formatVersion '${LP_PACK_FORMAT_VERSION}' is not supported by this runner (it understands ${LP_PACK_SUPPORTED_FORMAT_VERSION})"
    fi
  fi

  [[ -n "${LP_PACK_ID}" ]] || lp_pack_problem "identity.id is missing: every event is attributed to a packId and this manifest has none"
  [[ -n "${LP_PACK_VERSION}" ]] || lp_pack_problem "identity.version is missing"

  # --- what starts it ------------------------------------------------------
  if [[ -z "${LP_PACK_START_COMMAND}" ]]; then
    lp_pack_problem "runtime.commands.start is missing: only a library pack may omit it, and a library pack is not something this runner can run"
  fi

  case "${LP_PACK_TARGET}" in
    node|bun|deno|python|go|rust|static)
      : ;;
    container)
      lp_pack_problem "runtime.target 'container' cannot be honoured: this host deploys into a systemd sandbox, not a container runtime (see infra/host/README.md for why)" ;;
    none)
      lp_pack_problem "runtime.target 'none' declares nothing to run" ;;
    "")
      lp_pack_problem "runtime.target is missing" ;;
    *)
      lp_pack_problem "runtime.target '${LP_PACK_TARGET}' is not a target this runner knows" ;;
  esac

  case "${LP_PACK_TARGET}" in
    node|bun|deno|python)
      tool="${LP_PACK_TARGET}"
      [[ "${tool}" == "python" ]] && tool="python3"
      command -v "${tool}" >/dev/null 2>&1 \
        || lp_pack_problem "runtime.target '${LP_PACK_TARGET}' needs '${tool}' on the host and it is not installed"
      ;;
  esac

  if [[ -n "${LP_PACK_VERSION_RANGE}" && "${LP_PACK_RUNTIME_VERSION}" != "unknown" ]]; then
    lp_pack_version_satisfies "${LP_PACK_VERSION_RANGE}" "${LP_PACK_RUNTIME_VERSION}"
    case "$?" in
      1) lp_pack_problem "runtime.versionRange '${LP_PACK_VERSION_RANGE}' is not satisfied: this host has ${LP_PACK_TARGET} ${LP_PACK_RUNTIME_VERSION}" ;;
      2) lp_warn "runtime.versionRange '${LP_PACK_VERSION_RANGE}' is not a form this runner checks; host has ${LP_PACK_TARGET} ${LP_PACK_RUNTIME_VERSION}, recorded as-is in conditions" ;;
    esac
  fi

  # --- where it listens ----------------------------------------------------
  if [[ "${LP_PACK_SERVICE_COUNT}" -gt 1 && "${LP_PACK_SERVICE_EXPLICIT}" != "yes" ]]; then
    lp_pack_problem "runtime.services declares ${LP_PACK_SERVICE_COUNT} services and a deployment gets one address and one port; name the one to run with --service <id>"
  fi

  if [[ "${LP_PACK_SERVICE_EXPLICIT}" == "yes" && -z "${LP_PACK_PORT_BINDING}" ]]; then
    lp_pack_problem "no runtime.services entry has id '${LP_PACK_SERVICE_ID}'"
  fi

  case "${LP_PACK_PORT_BINDING}" in
    environment)
      [[ -n "${LP_PACK_PORT_ENV_VAR}" ]] \
        || lp_pack_problem "runtime.services[${LP_PACK_SERVICE_ID}].binding is 'environment' with no envVar" ;;
    fixed)
      if [[ -n "${LP_PACK_FIXED_PORT}" ]]; then
        port_in_use="$(ss -ltnH "sport = :${LP_PACK_FIXED_PORT}" 2>/dev/null | awk '{print $4}' | grep -E '^(0\.0\.0\.0|\*|\[::\])' || true)"
        [[ -z "${port_in_use}" ]] \
          || lp_pack_problem "runtime.services[${LP_PACK_SERVICE_ID}] pins port ${LP_PACK_FIXED_PORT} and something on this host already listens on it across all addresses (${port_in_use})"
      fi ;;
    dynamic)
      lp_pack_problem "runtime.services[${LP_PACK_SERVICE_ID}].binding is 'dynamic': this runner has to know the port to health-probe it and to hand out a URL, and a runtime-chosen port cannot be discovered from outside the sandbox" ;;
    "")
      [[ "${LP_PACK_SERVICE_COUNT}" -gt 0 ]] \
        || lp_pack_problem "runtime.services is empty: a deployment is a service on a port, and nothing here declares one" ;;
    *)
      lp_pack_problem "runtime.services[${LP_PACK_SERVICE_ID}].binding.type '${LP_PACK_PORT_BINDING}' is unknown" ;;
  esac

  # --- what it may reach ---------------------------------------------------
  if [[ "${egress_override}" != "public" && "${egress_override}" != "none" ]]; then
    for host in "${LP_PACK_HOSTS[@]}"; do
      [[ -n "${host}" ]] || continue
      if [[ "${host}" == \*.* ]]; then
        lp_pack_problem "permissions.network declares the wildcard host '${host}'. The sandbox filters by address, so a declared host is resolved to addresses at deploy time and a wildcard cannot be enumerated. Deploy it deliberately with --egress public (the coarser 'anywhere public' list) if that is what you mean."
        continue
      fi
      if [[ -z "$(getent ahosts "${host}" 2>/dev/null | awk 'NR==1 {print $1}')" ]]; then
        lp_pack_problem "permissions.network declares '${host}' and it does not resolve from this host, so no allow entry can be written for it"
      fi
    done
  fi

  # --- what it may hold ----------------------------------------------------
  while read -r elevated; do
    [[ -n "${elevated}" ]] || continue
    lp_pack_problem "permissions.elevated declares '${elevated}': the workspace unit runs with an empty capability bounding set, NoNewPrivileges, a seccomp filter and no docker socket, so this cannot be granted"
  done < <(jq -r '.permissions.elevated // [] | .[].capability' "$(lp_pack_manifest)" 2>/dev/null || true)

  while read -r fs_root; do
    [[ -n "${fs_root}" ]] || continue
    case "${fs_root}" in
      pack|data|tmp) : ;;
      home)
        lp_pack_problem "permissions.filesystem asks for the 'home' root: the unit sets ProtectHome=yes, which renders /home and /root empty" ;;
      workspace)
        lp_pack_problem "permissions.filesystem asks for the 'workspace' root: this runner gives a pack its own directory and nothing outside it" ;;
      absolute)
        lp_pack_problem "permissions.filesystem asks for an 'absolute' path: the host is mounted read-only apart from the deployment's own directory" ;;
      *)
        lp_pack_problem "permissions.filesystem root '${fs_root}' is unknown" ;;
    esac
  done < <(jq -r '.permissions.filesystem // [] | .[].root' "$(lp_pack_manifest)" 2>/dev/null || true)

  # --- what the consumer had to bring --------------------------------------
  missing=""
  for name in "${LP_PACK_REQUIRED_ENV[@]}"; do
    [[ -n "${name}" ]] || continue
    grep -qw -- "${name}" <<<"${supplied_env_names}" || missing+=" ${name}"
  done
  [[ -z "${missing}" ]] \
    || lp_pack_problem "requirements.environment marks these required and nothing supplied them:${missing}. Pass them with --env-file; a missing requirement is an install defect, not something to discover at runtime."

  while read -r name; do
    [[ -n "${name}" ]] || continue
    grep -qw -- "${name}" <<<"${supplied_env_names}" \
      || lp_pack_problem "requirements.services declares a dependency reached through ${name} and nothing supplied it; this runner provisions no databases or queues"
  done < <(jq -r '.requirements.services // [] | .[] | select(.connectionEnvVar) | .connectionEnvVar' "$(lp_pack_manifest)" 2>/dev/null || true)

  while read -r name; do
    [[ -n "${name}" ]] || continue
    lp_pack_problem "requirements.packs declares a dependency on pack '${name}': this runner deploys one pack and resolves no pack graph"
  done < <(jq -r '.requirements.packs // [] | .[].name' "$(lp_pack_manifest)" 2>/dev/null || true)

  while read -r tool; do
    [[ -n "${tool}" ]] || continue
    command -v "${tool}" >/dev/null 2>&1 \
      || lp_pack_problem "requirements.toolchain declares '${tool}' and it is not on this host"
  done < <(jq -r '.requirements.toolchain // [] | .[].name' "$(lp_pack_manifest)" 2>/dev/null || true)

  # --- honoured, but not exactly as declared -------------------------------
  # Stated rather than refused: refusing every manifest that names a port would
  # refuse almost all of them, and the gap is in the enforcement layer, not in
  # the pack. It is repeated in deployment.provisioned so a consumer of the
  # telemetry sees it too.
  if [[ "${LP_PACK_PORTS_DECLARED}" == "yes" ]]; then
    lp_warn "permissions.network names ports; systemd's IP filter matches addresses only, so a declared host is reachable on any port. Recorded as portRestrictionsEnforced=false."
  fi

  if [[ "$(lp_pack_query '.permissions.acceptsInboundNetwork')" == "false" ]]; then
    lp_warn "permissions.acceptsInboundNetwork is false, but the interfaces declare a service this runner health-probes and hands out a URL for"
  fi

  [[ "${#LP_PACK_PROBLEMS[@]}" -eq 0 ]]
}

lp_pack_die_on_problems() {
  local problem

  [[ "${#LP_PACK_PROBLEMS[@]}" -gt 0 ]] || return 0

  printf '[lp] ERROR: this host cannot honour %s declaration(s) in %s:\n' \
    "${#LP_PACK_PROBLEMS[@]}" "$(lp_pack_manifest)" >&2
  for problem in "${LP_PACK_PROBLEMS[@]}"; do
    printf '[lp]   - %s\n' "${problem}" >&2
  done
  printf '[lp] refusing to deploy: running it anyway would give it weaker guarantees than its own manifest declares\n' >&2
  exit 1
}

# Every address the declared hosts resolve to right now, as "host address"
# pairs. Resolution happens at deploy time and the result is a fixed allow list,
# which is exactly as durable as the DNS records behind it — see the README.
#
# Both families. A dual-stack client tries the AAAA record first, so an IPv4-only
# allow list makes a pack's own declared destination fail once per connection
# before it falls back — a denial of something the manifest declared, which is
# the reading `egress.denied` is least able to afford being wrong about.
lp_pack_resolve_hosts() {
  local host address

  for host in "${LP_PACK_HOSTS[@]}"; do
    [[ -n "${host}" ]] || continue
    [[ "${host}" == \*.* ]] && continue
    while read -r address; do
      [[ -n "${address}" ]] || continue
      printf '%s %s\n' "${host}" "${address}"
    done < <(getent ahosts "${host}" 2>/dev/null | awk '{print $1}' | sort -u)
  done
}

# The interfaces a consumer touches, flattened to "kind:id" for the deploy
# report. Tier 2 begins here: this is the declared surface a later failure event
# gets scoped to.
lp_pack_interface_summary() {
  jq -r '[.interfaces // [] | .[] | "\(.kind):\(.id)"] | join(", ")' "$(lp_pack_manifest)" 2>/dev/null || printf ''
}
