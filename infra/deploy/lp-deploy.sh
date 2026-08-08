#!/usr/bin/env bash
# Deploy runner for isolated workspaces.
#
# Takes a workspace id and a `.pack` directory, reads its manifest, provisions
# the workspace using infra/host/lp-provision-workspace.sh, installs the pack,
# starts it under the hardened lp-workspace@.service unit, and reports the local
# URL it answers on.
#
# This layer owns exactly four things the isolation layer below it does not:
# where the build goes, what command starts it, which addresses the running
# service may exchange packets with, and what the deployment tells the control
# plane about itself. Everything else — the user, the sandbox, the resource caps
# — is inherited, not restated.
#
# What starts it, where it listens and what it may reach are *derived from the
# manifest*, not restated on the command line. A pack whose manifest declares
# something this host cannot honour is refused with the field named, because
# deploying it anyway would run it with weaker guarantees than it declares and
# then attribute its telemetry to a configuration nobody chose.
#
# A build directory with an explicit --command is still accepted. It carries no
# manifest, so it gets tier-1 lifecycle events attributed by content digest and
# nothing above that.
#
# The workload never runs as root. Root is required to run *this* script
# (creating users, writing units, adding loopback aliases all need it) and the
# `up` path asserts the resulting service's identity before reporting success.
#
# Usage:
#   lp-deploy.sh up <workspace-id> --pack <dir.pack> [options]
#   lp-deploy.sh up <workspace-id> --from <dir> --command <cmd> [options]
#   lp-deploy.sh plan --pack <dir.pack> [--env-file <file>]
#   lp-deploy.sh status|logs|events|start|stop|restart|down <workspace-id> [options]
#   lp-deploy.sh list

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lp-deploy-common.sh
source "${script_dir}/lp-deploy-common.sh"
# shellcheck source=./lp-pack.sh
source "${script_dir}/lp-pack.sh"

usage() {
  cat <<'EOF'
Usage: lp-deploy.sh <command> [arguments]

Commands:
  up <id> --pack <dir.pack>              Provision, install, start, report a URL
  up <id> --from <dir> --command <cmd>   Same, for a build with no manifest
  plan --pack <dir.pack>                 Print what a pack would get, change nothing
  status <id>                            Unit state, URL, reachability probes
  logs <id> [--lines N] [--follow]       Journal for the workspace's service
  events <id> [--lines N]                The tier-1 telemetry this deployment emitted
  start <id> | stop <id> | restart <id>  Lifecycle without touching the build
  down <id> [--keep-data]                Stop and remove everything created
  list                                   Every deployment on this host

Options for `up`:
  --pack <dir>           A .pack directory: its pack.json decides the start
                         command, the runtime, the port and the egress rules
  --from <dir>           Directory containing a built application (no manifest)
  --command <cmd>        Start command, required with --from, refused with --pack
  --env-file <file>      KEY=VALUE lines handed to the service. Required
                         variables the manifest declares must appear here.
  --environment <env>    production | preview | development (default development)
  --service <id>         Which runtime.services entry owns the port, when the
                         manifest declares more than one
  --health-path <path>   Overrides the service's declared healthPath
  --egress <mode>        pack (derived from permissions.network, the default for
                         --pack), public (anywhere routable, no loopback/private/
                         host), or none. --from defaults to public.
  --port <port>          Pin the TCP port instead of allocating one
  --memory-max <value>   Passed through to provisioning (default 512M)
  --tasks-max <count>    Passed through to provisioning (default 64)
  --max-size-mb <mb>     Refuse builds larger than this (default 2048)
  --health-timeout <s>   Seconds to wait for the first successful probe (default 30)
  --heartbeat-interval <s>  Telemetry tick, and the unit silence is counted in
                         (default 60; went_quiet fires after 3 missed ticks)

The application is told where to listen through HOST, PORT, LP_BIND_ADDRESS and
LP_PORT, plus whatever the manifest's port binding names. It MUST bind the
address it is given: `up` fails the deploy if the service turns out to be
reachable from outside the host.

Telemetry is written as newline-delimited JSON to /var/lib/lp-telemetry/<id>/,
root-owned, outside the workspace. Read it with `events`.
EOF
}

# --- argument parsing -----------------------------------------------------

command_name="${1-}"
[[ -n "${command_name}" ]] || { usage; exit 1; }
shift || true

case "${command_name}" in
  -h|--help|help) usage; exit 0 ;;
esac

workspace_id=""
source_dir=""
pack_dir=""
env_file=""
environment="development"
start_command=""
health_path=""
egress_mode=""
requested_port=""
memory_max=""
tasks_max=""
max_size_mb="${LP_DEPLOY_MAX_SIZE_MB_DEFAULT}"
health_timeout="30"
heartbeat_interval="${LP_HEARTBEAT_INTERVAL_SECONDS}"
log_lines="200"
follow_logs="no"
keep_data="no"
installed_bytes="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --pack) [[ $# -ge 2 ]] || lp_die "--pack requires a directory"; pack_dir="$2"; shift 2 ;;
    --from) [[ $# -ge 2 ]] || lp_die "--from requires a directory"; source_dir="$2"; shift 2 ;;
    --command) [[ $# -ge 2 ]] || lp_die "--command requires a value"; start_command="$2"; shift 2 ;;
    --env-file) [[ $# -ge 2 ]] || lp_die "--env-file requires a path"; env_file="$2"; shift 2 ;;
    --environment) [[ $# -ge 2 ]] || lp_die "--environment requires a value"; environment="$2"; shift 2 ;;
    --service)
      [[ $# -ge 2 ]] || lp_die "--service requires a value"
      LP_PACK_SERVICE_ID="$2"; LP_PACK_SERVICE_EXPLICIT="yes"; shift 2 ;;
    --health-path) [[ $# -ge 2 ]] || lp_die "--health-path requires a value"; health_path="$2"; shift 2 ;;
    --egress) [[ $# -ge 2 ]] || lp_die "--egress requires a value"; egress_mode="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || lp_die "--port requires a value"; requested_port="$2"; shift 2 ;;
    --memory-max) [[ $# -ge 2 ]] || lp_die "--memory-max requires a value"; memory_max="$2"; shift 2 ;;
    --tasks-max) [[ $# -ge 2 ]] || lp_die "--tasks-max requires a value"; tasks_max="$2"; shift 2 ;;
    --max-size-mb) [[ $# -ge 2 ]] || lp_die "--max-size-mb requires a value"; max_size_mb="$2"; shift 2 ;;
    --health-timeout) [[ $# -ge 2 ]] || lp_die "--health-timeout requires a value"; health_timeout="$2"; shift 2 ;;
    --heartbeat-interval) [[ $# -ge 2 ]] || lp_die "--heartbeat-interval requires a value"; heartbeat_interval="$2"; shift 2 ;;
    --lines) [[ $# -ge 2 ]] || lp_die "--lines requires a value"; log_lines="$2"; shift 2 ;;
    --follow) follow_logs="yes"; shift ;;
    --keep-data) keep_data="yes"; shift ;;
    -*) lp_die "unknown option '$1' (try --help)" ;;
    *)
      [[ -z "${workspace_id}" ]] || lp_die "unexpected extra argument '$1'"
      workspace_id="$1"; shift ;;
  esac
done

case "${command_name}" in
  list|plan) : ;;
  *) lp_validate_workspace_id "${workspace_id}" ;;
esac

# `plan` reads a manifest and touches nothing, so it deliberately does not
# demand root: refusing a pack is exactly the answer somebody wants before they
# have a host to refuse it on.
[[ "${command_name}" == "plan" ]] || lp_require_root

user_name="$(lp_user_for "${workspace_id:-placeholder}")"
workspace_dir="$(lp_dir_for "${workspace_id:-placeholder}")"
app_dir="$(lp_deploy_app_dir_for "${workspace_id:-placeholder}")"
unit_name="$(lp_unit_for "${workspace_id:-placeholder}")"
dropin_file="$(lp_deploy_dropin_for "${workspace_id:-placeholder}")"

# --- helpers --------------------------------------------------------------

require_deployed() {
  [[ -f "${dropin_file}" ]] || lp_die "workspace '${workspace_id}' has no deployment (run 'up' first)"
}

deployed_address() { lp_deploy_dropin_field "${dropin_file}" lp-address; }
deployed_port() { lp_deploy_dropin_field "${dropin_file}" lp-port; }

supplied_env_names() {
  [[ -n "${env_file}" && -f "${env_file}" ]] || return 0
  # Names only. A value never leaves this file: the runner installs it for the
  # service and nothing downstream — no log line, no event — ever reads one.
  grep -oE '^[[:space:]]*[A-Z][A-Z0-9_]*' -- "${env_file}" | tr -d '[:blank:]' | tr '\n' ' '
}

# The exact set of prefixes the deployment may address. Computed once and used
# twice — for the unit's IPAddressAllow= and for the observation table that
# reports what fell outside it — so the enforced set and the observed set are
# the same set by construction rather than by review.
allow_prefixes_for() {
  local mode="$1" address="$2" host resolved_any="no"

  case "${mode}" in
    public)
      lp_deploy_public_allow_prefixes
      printf '127.0.0.53/32\n'
      ;;
    pack)
      while read -r host resolved; do
        [[ -n "${resolved}" ]] || continue
        if [[ "${resolved}" == *:* ]]; then
          printf '%s/128\n' "${resolved}"
        else
          printf '%s/32\n' "${resolved}"
        fi
        resolved_any="yes"
      done < <(lp_pack_resolve_hosts)
      # No declared destination means no resolver either: a pack that talks to
      # nothing has no reason to be able to ask where anything is.
      [[ "${resolved_any}" == "yes" ]] && printf '127.0.0.53/32\n'
      ;;
    none) : ;;
  esac

  printf '%s/32\n' "${address}"
}

# Renders the network drop-in.
#
# The template's `IPAddressDeny=any` is the default: an address that matches no
# allow entry is dropped. Everything below is therefore expressed as allows —
# there is no "deny 127.0.0.0/8" line anywhere, because in systemd's model an
# allow entry beats a deny entry outright and a deny for a range already covered
# by an allow does nothing at all. Loopback is blocked here by being *absent*
# from the enumerated allow list, not by being denied.
write_network_dropin() {
  local address="$1" port="$2" mode="$3" prefixes="$4"
  local dropin_dir hosts_csv

  dropin_dir="$(dirname -- "${dropin_file}")"
  hosts_csv="$(printf '%s\n' "${LP_PACK_HOSTS[@]-}" | sed '/^$/d' | paste -sd, -)"

  mkdir -p "${dropin_dir}"

  {
    printf '# Generated by lp-deploy.sh for workspace %s. Do not edit by hand.\n' "${workspace_id}"
    printf '# lp-address=%s\n' "${address}"
    printf '# lp-port=%s\n' "${port}"
    printf '# lp-egress=%s\n' "${mode}"
    printf '# lp-health-path=%s\n' "${health_path}"
    printf '# lp-egress-hosts=%s\n' "${hosts_csv}"
    printf '# lp-pack-id=%s\n' "${LP_PACK_ID}"
    printf '# lp-content-digest=%s\n' "${LP_PACK_CONTENT_DIGEST}"
    printf '# lp-start-digest=%s\n' "$(printf '%s' "${start_command}" | sha256sum | cut -c1-64)"
    printf '\n[Service]\n'

    # Placed in a root-owned drop-in rather than the workspace-writable `env`
    # file the template reads, and parsed after it, so a workspace cannot move
    # itself onto another address by editing its own configuration.
    printf 'Environment=LP_WORKSPACE_ID=%s\n' "${workspace_id}"
    printf 'Environment=LP_BIND_ADDRESS=%s\n' "${address}"
    printf 'Environment=LP_PORT=%s\n' "${port}"
    printf 'Environment=HOST=%s\n' "${address}"
    printf 'Environment=PORT=%s\n' "${port}"
    # The manifest may name its own variable for the port. Set here rather than
    # left to the pack, because the runner allocated the port and the binding
    # declaration is the pack's statement of where it expects to read it.
    if [[ "${LP_PACK_PORT_BINDING}" == "environment" && -n "${LP_PACK_PORT_ENV_VAR}" ]]; then
      printf 'Environment=%s=%s\n' "${LP_PACK_PORT_ENV_VAR}" "${port}"
    fi

    printf '\n# Turns byte counters on so egress can be observed, not just filtered.\n'
    printf 'IPAccounting=yes\n\n'

    case "${mode}" in
      public)
        printf '# The public IPv4 space, computed as everything minus loopback, the\n'
        printf '# RFC1918 and carrier-grade ranges, link-local (which carries the cloud\n'
        printf '# metadata address), multicast, reserved space, and every address\n'
        printf '# configured on this host, plus the stub resolver and this deployment.\n' ;;
      pack)
        printf '# Exactly what permissions.network declares, resolved to addresses at\n'
        printf '# deploy time, plus the stub resolver and this deployment. A pack that\n'
        printf '# declares no egress gets none.\n' ;;
      none)
        printf '# Sealed: this deployment may address itself and nothing else, not even\n'
        printf '# the resolver.\n' ;;
    esac

    printf '%s\n' "${prefixes}" | while read -r prefix; do
      [[ -n "${prefix}" ]] || continue
      printf 'IPAddressAllow=%s\n' "${prefix}"
    done

    case "${mode}" in
      pack)
        printf '\n# IPv6 appears above only as the /128s the declared hosts resolve to.\n'
        printf '# Everything else in IPv6 stays covered by the template deny.\n' ;;
      *)
        printf '\n# IPv6 is left with no allow entry at all, so the template deny covers\n'
        printf '# it. Computing an IPv6 complement is not worth it here: nothing on this\n'
        printf '# host listens on IPv6, and a dual-stack client falls back to IPv4.\n' ;;
    esac
  } >"${dropin_file}"

  chmod 0644 "${dropin_file}"
}

install_build() {
  local source="$1"
  local size_mb available_mb

  [[ -d "${source}" ]] || lp_die "'${source}' is not a directory"

  size_mb="$(du -sm -- "${source}" | awk '{print $1}')"
  installed_bytes="$(du -sb -- "${source}" | awk '{print $1}')"
  [[ "${size_mb}" -le "${max_size_mb}" ]] \
    || lp_die "build at '${source}' is ${size_mb}MB, over the ${max_size_mb}MB limit; pass --max-size-mb to raise it deliberately"

  # rsync writes the new tree beside the old one before deleting, so the guard
  # asks for room for both copies plus headroom rather than just the build size.
  available_mb="$((size_mb * 2 + 128))"
  lp_check_disk "${available_mb}"

  lp_log "installing build (${size_mb}MB) into ${app_dir}"
  mkdir -p "${app_dir}"
  rsync -a --delete -- "${source}/" "${app_dir}/" || lp_die "rsync failed copying '${source}' into ${app_dir}"
  chown -R "${user_name}:${user_name}" "${app_dir}"
  chmod 0700 "${app_dir}"
}

write_run_file() {
  local command="$1" cwd="${2-}"
  local run_file="${workspace_dir}/run"

  cat >"${run_file}" <<EOF
#!/usr/bin/env bash
# Generated by lp-deploy.sh for workspace ${workspace_id}. Rewritten on every
# deploy; edits here are lost. The unit's ExecStart points at this file, so it
# is the single seam between the fixed sandbox and the workspace's own command.
set -euo pipefail

cd "\$(dirname -- "\${BASH_SOURCE[0]}")/app${cwd:+/${cwd}}"
exec ${command}
EOF

  chown "${user_name}:${user_name}" "${run_file}"
  chmod 0700 "${run_file}"
}

# Values the manifest declared as requirements. Written 0600 and owned by the
# workspace: they are its secrets, and nothing here ever copies a value into an
# event — telemetry carries variable names, never their contents.
write_env_file() {
  local target="${workspace_dir}/env"

  [[ -n "${env_file}" ]] || return 0
  [[ -f "${env_file}" ]] || lp_die "--env-file '${env_file}' does not exist"

  install -m 0600 -o "${user_name}" -g "${user_name}" -- "${env_file}" "${target}"
  lp_log "installed $(grep -cE '^[[:space:]]*[A-Z]' -- "${env_file}" || printf 0) environment values from ${env_file}"
}

# The whole point of the layer below is that nothing here runs privileged, so
# the claim is checked against the running process rather than assumed from the
# unit file.
#
# Read from /proc rather than `ps`, and only once the service has answered a
# request: systemd publishes MainPID immediately after forking, while the child
# is still root and has not yet dropped to User=. Sampling earlier reports root
# for every healthy deployment.
assert_not_root() {
  local main_pid uid actual_user

  main_pid="$(systemctl show "${unit_name}" -p MainPID --value)"
  [[ -n "${main_pid}" && "${main_pid}" != "0" ]] || lp_die "${unit_name} has no main process; deployment failed"

  # Field 3 of the Uid line is the effective uid.
  uid="$(awk '/^Uid:/ {print $3; exit}' "/proc/${main_pid}/status" 2>/dev/null || true)"
  [[ -n "${uid}" ]] || lp_die "could not read /proc/${main_pid}/status for ${unit_name}"

  [[ "${uid}" != "0" ]] \
    || lp_die "${unit_name} main process is running as root; refusing to report a successful deploy"

  actual_user="$(getent passwd "${uid}" | cut -d: -f1)"
  [[ "${actual_user}" == "${user_name}" ]] \
    || lp_warn "${unit_name} runs as '${actual_user}' (uid ${uid}), expected '${user_name}'"

  lp_log "service runs as ${actual_user} (uid ${uid}, pid ${main_pid}), not root"
}

# A service that ignored HOST and bound 0.0.0.0 is reachable from the internet
# on a host with a public address. Under --egress public the IP filter cannot
# stop that (public sources are allowed), so it is caught here instead.
assert_not_publicly_bound() {
  local port="$1" public_address

  public_address="$(ip -4 -o addr show scope global 2>/dev/null | awk 'NR==1 {split($4, a, "/"); print a[1]}')"
  [[ -n "${public_address}" ]] || return 0

  if curl -fsS -o /dev/null --max-time 3 "http://${public_address}:${port}${health_path}" 2>/dev/null; then
    lp_warn "service answered on ${public_address}:${port} — it ignored HOST and bound a wildcard address"
    systemctl stop "${unit_name}" || true
    lp_die "stopped ${unit_name}: a deployment must bind LP_BIND_ADDRESS only"
  fi

  lp_log "not reachable on the host's public address ${public_address}:${port}"
}

report() {
  local address port
  address="$(deployed_address)"
  port="$(deployed_port)"

  printf '\n'
  printf 'workspace   %s\n' "${workspace_id}"
  printf 'unit        %s\n' "${unit_name}"
  printf 'user        %s\n' "${user_name}"
  printf 'app         %s\n' "${app_dir}"
  if [[ -n "${LP_PACK_ID}" ]]; then
    printf 'pack        %s %s (%s)\n' "${LP_PACK_NAME}" "${LP_PACK_VERSION}" "${LP_PACK_ID}"
    printf 'digest      sha256:%s\n' "${LP_PACK_CONTENT_DIGEST}"
    printf 'interfaces  %s\n' "$(lp_pack_interface_summary)"
  fi
  printf 'egress      %s\n' "$(lp_deploy_dropin_field "${dropin_file}" lp-egress || printf 'unknown')"
  printf 'telemetry   %s\n' "$(lp_tel_events_for "${workspace_id}")"
  printf 'url         %s\n' "$(lp_deploy_url_for "${address}" "${port}")"
}

# --- telemetry attribution ------------------------------------------------
#
# Written once per deploy and read by every emitter afterwards. `contentDigest`
# is the field that carries the weight: the contract is explicit that a version
# is a promise about behaviour rather than a statement about bytes, so a finding
# attributed to a version blames code that may never have run.
write_telemetry_refs() {
  local address="$1" port="$2" mode="$3" prefix_count="$4"
  local workspace_key install_id deployment_id first_seen arch providers

  lp_tel_init "${workspace_id}"

  # Non-reversible, and salted with the host's machine id so the same workspace
  # id on two hosts does not produce the same handle. Two events can be proved
  # to share an origin; neither names the workspace.
  workspace_key="wsk_$(printf '%s|%s' "$(cat /etc/machine-id 2>/dev/null || printf 'nomachineid')" "${workspace_id}" | sha256sum | cut -c1-12)"

  deployment_id="$(lp_tel_state_read "${workspace_id}" deployment-id "")"
  if [[ -z "${deployment_id}" ]]; then
    deployment_id="dep_$(lp_ulid)"
    lp_tel_state_write "${workspace_id}" deployment-id "${deployment_id}"
  fi

  first_seen="$(lp_tel_state_read "${workspace_id}" first-seen-epoch "")"
  if [[ -z "${first_seen}" ]]; then
    first_seen="$(date +%s)"
    lp_tel_state_write "${workspace_id}" first-seen-epoch "${first_seen}"
  fi

  install_id="inst_$(printf '%s|%s' "${LP_PACK_ID}" "${workspace_key}" | sha256sum | cut -c1-12)"

  case "$(uname -m)" in
    x86_64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) arch="unknown" ;;
  esac

  # One entry per declared account, every axis "unknown". Absence is not a
  # value: "we could not determine the tier" has to be distinguishable from
  # "nobody thought to record it", and this runner genuinely cannot determine
  # any of them.
  providers="$(
    printf '%s\n' "${LP_PACK_ACCOUNTS[@]-}" \
      | jq -R -s -c 'split("\n") | map(select(length > 0)) | map({
          id: ., accountTier: "unknown", region: "unknown",
          consoleVersion: "unknown", apiVersion: "unknown", authMode: "unknown"
        })'
  )"

  lp_tel_write_ref "${workspace_id}" pack-ref "$(
    jq -nc \
      --arg packId "${LP_PACK_ID}" \
      --arg version "${LP_PACK_VERSION}" \
      --arg contentDigest "sha256:${LP_PACK_CONTENT_DIGEST}" \
      --arg formatVersion "${LP_PACK_FORMAT_VERSION}" \
      --argjson derivedFrom "${LP_PACK_DERIVED_FROM_JSON:-null}" \
      --arg installId "${install_id}" \
      '{
        packId: (if $packId == "" then null else $packId end),
        version: (if $version == "" then null else $version end),
        contentDigest: $contentDigest,
        formatVersion: (if $formatVersion == "" then null else $formatVersion end),
        derivedFrom: $derivedFrom,
        installId: $installId,
        mutations: { count: 0, digest: null, lastAppliedAt: null }
      }'
  )"

  lp_tel_write_ref "${workspace_id}" deployment-ref "$(
    jq -nc \
      --arg deploymentId "${deployment_id}" \
      --arg workspaceKeyId "${workspace_key}" \
      --arg environment "${environment}" \
      --arg visibility "${LP_PACK_VISIBILITY:-workspace}" \
      --arg firstSeenAt "$(date -u -d "@${first_seen}" +%Y-%m-%dT%H:%M:%S.000Z)" \
      '{
        deploymentId: $deploymentId,
        deploymentRunId: null,
        workspaceKeyId: $workspaceKeyId,
        environment: $environment,
        visibility: $visibility,
        runtimeHost: "logicpacks-managed",
        sdkVersion: null,
        firstSeenAt: $firstSeenAt,
        ageDays: 0
      }'
  )"

  lp_tel_write_ref "${workspace_id}" conditions "$(
    jq -nc \
      --argjson providers "${providers}" \
      --arg language "${LP_PACK_TARGET:-unknown}" \
      --arg languageVersion "${LP_PACK_RUNTIME_VERSION:-unknown}" \
      --arg arch "${arch}" \
      --arg timezone "$(timedatectl show -p Timezone --value 2>/dev/null || printf 'unknown')" \
      '{
        providers: $providers,
        runtime: { language: $language, languageVersion: $languageVersion, os: "linux", arch: $arch, containerized: false },
        dependencies: [],
        agent: { role: "installer", provider: "unknown", model: "unknown" },
        surface: "logicpacks",
        locale: "unknown",
        timezone: $timezone
      }'
  )"

  lp_tel_state_write "${workspace_id}" heartbeat-interval "${heartbeat_interval}"
  lp_tel_state_write "${workspace_id}" egress-mode "${mode}"
  lp_tel_state_write "${workspace_id}" allowed-prefix-count "${prefix_count}"
  lp_tel_state_write "${workspace_id}" bind "${address}:${port}"
}

# --- commands -------------------------------------------------------------

# Derives every deploy decision from the manifest, or refuses. Shared by `up`
# and `plan` so the two can never disagree about what a pack would get.
resolve_pack() {
  lp_tel_require_jq
  lp_pack_load "${pack_dir}"
  lp_pack_check "$(supplied_env_names)" "${egress_mode}" || true
  lp_pack_die_on_problems

  start_command="${LP_PACK_START_COMMAND}"
  [[ -n "${health_path}" ]] || health_path="${LP_PACK_HEALTH_PATH}"
  [[ -n "${health_path}" ]] || health_path="/"
  [[ -n "${egress_mode}" ]] || egress_mode="pack"
  if [[ "${LP_PACK_PORT_BINDING}" == "fixed" && -z "${requested_port}" ]]; then
    requested_port="${LP_PACK_FIXED_PORT}"
  fi
}

cmd_plan() {
  local host resolved

  [[ -n "${pack_dir}" ]] || lp_die "plan requires --pack <dir.pack>"
  resolve_pack

  printf 'pack        %s %s (%s, format %s)\n' \
    "${LP_PACK_NAME}" "${LP_PACK_VERSION}" "${LP_PACK_ID}" "${LP_PACK_FORMAT_VERSION}"
  printf 'digest      sha256:%s\n' "${LP_PACK_CONTENT_DIGEST}"
  printf 'interfaces  %s\n' "$(lp_pack_interface_summary)"
  printf 'runtime     %s %s (host has %s)\n' \
    "${LP_PACK_TARGET}" "${LP_PACK_VERSION_RANGE:-any}" "${LP_PACK_RUNTIME_VERSION}"
  printf 'start       %s\n' "${start_command}"
  printf 'cwd         app/%s\n' "${LP_PACK_START_CWD}"
  printf 'service     %s, binding %s%s\n' \
    "${LP_PACK_SERVICE_ID}" "${LP_PACK_PORT_BINDING}" \
    "${LP_PACK_PORT_ENV_VAR:+ via ${LP_PACK_PORT_ENV_VAR}}"
  printf 'health      %s\n' "${health_path}"
  printf 'egress      %s\n' "${egress_mode}"

  while read -r host resolved; do
    [[ -n "${resolved}" ]] || continue
    printf '  allow     %-40s %s\n' "${host}" "${resolved}"
  done < <(lp_pack_resolve_hosts)

  if [[ "${#LP_PACK_HOSTS[@]}" -eq 0 ]]; then
    printf '  allow     (nothing declared — no egress, not even DNS)\n'
  fi
  printf 'plan only: nothing on this host was changed\n'
}

cmd_up() {
  local address port existing_address existing_port prefixes prefix_count
  local start_epoch_ms healthy_epoch_ms attempts run_id uid status_code

  if [[ -n "${pack_dir}" ]]; then
    [[ -z "${source_dir}" ]] || lp_die "--pack and --from are alternatives; pass one"
    [[ -z "${start_command}" ]] || lp_die "--command is refused with --pack: the start command comes from runtime.commands.start, which is the point of reading the manifest"
    resolve_pack
    source_dir="${LP_PACK_DIR}"
  else
    [[ -n "${source_dir}" ]] || lp_die "up requires --pack <dir.pack> (or --from <dir> --command <cmd> for a build with no manifest)"
    [[ -n "${start_command}" ]] || lp_die "up requires --command <cmd> with --from"
    lp_tel_require_jq
    source_dir="$(cd -- "${source_dir}" 2>/dev/null && pwd)" || lp_die "--from '${source_dir}' is not a readable directory"
    # No manifest means no packId and no declared surface, but the bytes are
    # still identifiable, and contentDigest is what the contract attributes by.
    LP_PACK_CONTENT_DIGEST="$(lp_pack_content_digest "${source_dir}")"
    [[ -n "${health_path}" ]] || health_path="/"
    [[ -n "${egress_mode}" ]] || egress_mode="public"
  fi

  [[ "${max_size_mb}" =~ ^[0-9]+$ ]] || lp_die "--max-size-mb must be an integer, got '${max_size_mb}'"
  [[ "${health_timeout}" =~ ^[0-9]+$ ]] || lp_die "--health-timeout must be an integer, got '${health_timeout}'"
  [[ "${heartbeat_interval}" =~ ^[0-9]+$ ]] || lp_die "--heartbeat-interval must be an integer, got '${heartbeat_interval}'"
  case "${environment}" in
    production|preview|development) : ;;
    *) lp_die "--environment must be production, preview or development, got '${environment}'" ;;
  esac
  case "${egress_mode}" in
    public|none|pack) : ;;
    *) lp_die "--egress must be 'pack', 'public' or 'none', got '${egress_mode}'" ;;
  esac
  if [[ "${egress_mode}" == "pack" && -z "${pack_dir}" ]]; then
    lp_die "--egress pack needs a manifest to derive the allow list from; pass --pack"
  fi
  if [[ -n "${requested_port}" ]]; then
    [[ "${requested_port}" =~ ^[0-9]+$ ]] || lp_die "--port must be an integer, got '${requested_port}'"
  fi

  local provision_args=("${workspace_id}")
  [[ -n "${memory_max}" ]] && provision_args+=(--memory-max "${memory_max}")
  [[ -n "${tasks_max}" ]] && provision_args+=(--tasks-max "${tasks_max}")

  lp_log "provisioning workspace '${workspace_id}'"
  "${LP_HOST_DIR}/lp-provision-workspace.sh" "${provision_args[@]}"

  existing_address="$(deployed_address || true)"
  existing_port="$(deployed_port || true)"
  [[ -n "${requested_port}" ]] && existing_port="${requested_port}"

  address="$(lp_deploy_allocate_address "${existing_address}")"
  port="$(lp_deploy_allocate_port "${existing_port}")"
  lp_log "address ${address}, port ${port}, egress ${egress_mode}"

  prefixes="$(allow_prefixes_for "${egress_mode}" "${address}")"
  prefix_count="$(sed '/^$/d' <<<"${prefixes}" | wc -l)"

  lp_deploy_ensure_loopback_alias "${address}"
  write_network_dropin "${address}" "${port}" "${egress_mode}" "${prefixes}"
  systemctl daemon-reload

  uid="$(id -u "${user_name}")"
  if printf '%s\n' "${prefixes}" | grep -v '^$' | lp_nft_install "${workspace_id}" "${uid}"; then
    lp_log "egress observation active (nft table $(lp_nft_table_for "${workspace_id}"))"
  else
    lp_warn "egress.denied will not be emitted for this deployment"
  fi

  install_build "${source_dir}"
  write_run_file "${start_command}" "${LP_PACK_START_CWD}"
  write_env_file

  write_telemetry_refs "${address}" "${port}" "${egress_mode}" "${prefix_count}"

  lp_tel_emit "${workspace_id}" deployment.provisioned "$(
    jq -nc \
      --argjson uid "${uid}" \
      --arg unit "${unit_name}" \
      --argjson memoryMaxBytes "$(lp_size_to_bytes "${memory_max:-${LP_DEFAULT_MEMORY_MAX}}")" \
      --argjson tasksMax "${tasks_max:-${LP_DEFAULT_TASKS_MAX}}" \
      --arg egressMode "${egress_mode}" \
      --argjson allowedPrefixCount "${prefix_count}" \
      --argjson buildSizeBytes "${installed_bytes}" \
      --argjson declaredHostCount "${#LP_PACK_HOSTS[@]}" \
      --argjson portRestrictionsEnforced "$(
        [[ "${LP_PACK_PORTS_DECLARED}" == "yes" ]] && printf 'false' || printf 'true'
      )" \
      '{uid: $uid, unit: $unit, memoryMaxBytes: $memoryMaxBytes, tasksMax: $tasksMax,
        egressMode: $egressMode, allowedPrefixCount: $allowedPrefixCount, buildSizeBytes: $buildSizeBytes,
        declaredHostCount: $declaredHostCount, portRestrictionsEnforced: $portRestrictionsEnforced}'
  )"

  start_epoch_ms="$(date +%s%3N)"
  lp_log "starting ${unit_name}"
  if ! systemctl restart "${unit_name}"; then
    lp_tel_emit "${workspace_id}" deployment.stopped "$(
      jq -nc \
        --argjson exitCode "$(systemctl show "${unit_name}" -p ExecMainStatus --value | grep -E '^[0-9]+$' || printf 'null')" \
        '{reason: "crash", exitCode: $exitCode, signal: null, uptimeSeconds: 0, phase: "start"}'
    )"
    journalctl -u "${unit_name}" -n 40 --no-pager || true
    lp_die "${unit_name} failed to start"
  fi

  run_id="$(lp_tel_rotate_run_id "${workspace_id}" "$(lp_tel_run_token "${unit_name}")")"
  lp_tel_emit "${workspace_id}" deployment.started "$(
    jq -nc \
      --arg deploymentRunId "${run_id}" \
      --arg startCommandDigest "$(printf '%s' "${start_command}" | sha256sum | cut -c1-64)" \
      --arg bindAddress "${address}" \
      --argjson port "${port}" \
      --argjson isRedeploy "$([[ -n "${existing_address}" ]] && printf 'true' || printf 'false')" \
      '{deploymentRunId: $deploymentRunId, startCommandDigest: $startCommandDigest, bindAddress: $bindAddress,
        port: $port, coldStartMs: null, isRedeploy: $isRedeploy, observedBy: "runner"}'
  )"

  local url="$(lp_deploy_url_for "${address}" "${port}")${health_path}"
  lp_log "waiting for ${url}"
  if ! lp_deploy_wait_healthy "${url}" "${health_timeout}"; then
    lp_tel_emit "${workspace_id}" deployment.unhealthy "$(
      jq -nc \
        --arg probePath "${health_path}" \
        --argjson consecutiveFailures "${health_timeout}" \
        --argjson unhealthyForMs "$(( $(date +%s%3N) - start_epoch_ms ))" \
        '{probePath: $probePath, lastStatusCode: null, consecutiveFailures: $consecutiveFailures,
          unhealthyForMs: $unhealthyForMs, phase: "first-probe"}'
    )"
    journalctl -u "${unit_name}" -n 40 --no-pager || true
    lp_die "no response from ${url} after ${health_timeout}s"
  fi
  healthy_epoch_ms="$(date +%s%3N)"
  lp_log "healthy"

  attempts="${LP_DEPLOY_HEALTH_ATTEMPTS:-1}"
  status_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${url}" 2>/dev/null || true)"
  [[ "${status_code}" =~ ^[0-9]+$ ]] && [[ "${status_code}" != "000" ]] || status_code="null"
  lp_tel_emit "${workspace_id}" deployment.healthy "$(
    jq -nc \
      --arg probePath "${health_path}" \
      --argjson statusCode "${status_code}" \
      --argjson timeToHealthyMs "$(( healthy_epoch_ms - start_epoch_ms ))" \
      --argjson attempts "${attempts}" \
      '{probePath: $probePath, statusCode: $statusCode, timeToHealthyMs: $timeToHealthyMs, attempts: $attempts}'
  )"
  lp_tel_state_write "${workspace_id}" last-heartbeat-epoch "$(date +%s)"
  lp_tel_state_write "${workspace_id}" health-failures 0

  assert_not_root
  assert_not_publicly_bound "${port}"

  lp_heartbeat_enable "${workspace_id}" "${heartbeat_interval}"
  lp_log "telemetry every ${heartbeat_interval}s; silence reported after ${LP_QUIET_AFTER_INTERVALS} missed ticks"

  report
}

cmd_status() {
  require_deployed

  local address port url
  address="$(deployed_address)"
  port="$(deployed_port)"
  url="$(lp_deploy_url_for "${address}" "${port}")"
  [[ -n "${health_path}" ]] || health_path="$(lp_deploy_dropin_field "${dropin_file}" lp-health-path || printf '/')"

  LP_PACK_ID="$(lp_deploy_dropin_field "${dropin_file}" lp-pack-id || printf '')"
  LP_PACK_CONTENT_DIGEST="$(lp_deploy_dropin_field "${dropin_file}" lp-content-digest || printf '')"

  report
  printf '\n'
  systemctl show "${unit_name}" \
    -p ActiveState -p SubState -p MainPID -p User -p NRestarts \
    -p MemoryCurrent -p TasksCurrent -p IPAddressDeny -p IPAddressAllow \
    -p IPIngressBytes -p IPEgressBytes

  printf '\ntelemetry\n'
  printf '  %-28s %s events\n' "$(lp_tel_events_for "${workspace_id}")" \
    "$(wc -l <"$(lp_tel_events_for "${workspace_id}")" 2>/dev/null || printf 0)"
  printf '  %-28s %s\n' "timer" "$(systemctl is-active "$(lp_heartbeat_timer_for "${workspace_id}")" 2>/dev/null || printf 'inactive')"

  printf '\nreachability\n'
  if curl -fsS -o /dev/null --max-time 3 "${url}${health_path}"; then
    printf '  %-28s reachable\n' "${url}${health_path}"
  else
    printf '  %-28s NOT reachable\n' "${url}${health_path}"
  fi

  # Answering here would mean the ingress filter is not in force: packets from
  # 127.0.0.1 are denied, so even a wildcard-bound service must refuse them.
  if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${port}${health_path}" 2>/dev/null; then
    printf '  %-28s REACHABLE (ingress filter not in force)\n' "http://127.0.0.1:${port}"
  else
    printf '  %-28s blocked, as expected\n' "http://127.0.0.1:${port}"
  fi
}

cmd_logs() {
  require_deployed

  [[ "${log_lines}" =~ ^[0-9]+$ ]] || lp_die "--lines must be an integer, got '${log_lines}'"

  if [[ "${follow_logs}" == "yes" ]]; then
    journalctl -u "${unit_name}" -n "${log_lines}" --follow
  else
    journalctl -u "${unit_name}" -n "${log_lines}" --no-pager
  fi
}

cmd_events() {
  local events
  events="$(lp_tel_events_for "${workspace_id}")"

  [[ -f "${events}" ]] || lp_die "no telemetry for '${workspace_id}' at ${events}"
  [[ "${log_lines}" =~ ^[0-9]+$ ]] || lp_die "--lines must be an integer, got '${log_lines}'"

  tail -n "${log_lines}" -- "${events}"
}

cmd_lifecycle() {
  local action="$1" run_id uptime
  require_deployed

  uptime="$(lp_deploy_uptime_seconds "${unit_name}")"

  case "${action}" in
    stop|restart)
      if systemctl is-active --quiet "${unit_name}"; then
        lp_tel_emit "${workspace_id}" deployment.stopped "$(
          jq -nc \
            --arg reason "$([[ "${action}" == "restart" ]] && printf 'redeploy' || printf 'operator')" \
            --argjson uptimeSeconds "${uptime}" \
            '{reason: $reason, exitCode: 0, signal: null, uptimeSeconds: $uptimeSeconds}'
        )"
        lp_tel_state_write "${workspace_id}" uptime-total \
          "$(( $(lp_tel_state_read "${workspace_id}" uptime-total 0) + uptime ))"
        # Claims the stop, so the next timer tick reports the same shutdown as a
        # second, differently-attributed event.
        lp_tel_state_write "${workspace_id}" stopped-token "$(lp_tel_state_read "${workspace_id}" run-token "")"
      fi ;;
  esac

  lp_log "${action} ${unit_name}"
  systemctl "${action}" "${unit_name}"
  systemctl is-active "${unit_name}" || true

  case "${action}" in
    start|restart)
      if systemctl is-active --quiet "${unit_name}"; then
        run_id="$(lp_tel_rotate_run_id "${workspace_id}" "$(lp_tel_run_token "${unit_name}")")"
        lp_tel_emit "${workspace_id}" deployment.started "$(
          jq -nc \
            --arg deploymentRunId "${run_id}" \
            --arg startCommandDigest "$(lp_deploy_dropin_field "${dropin_file}" lp-start-digest || printf '')" \
            --arg bindAddress "$(deployed_address || printf '')" \
            --argjson port "$(deployed_port || printf 'null')" \
            --argjson isRedeploy "$([[ "${action}" == "restart" ]] && printf 'true' || printf 'false')" \
            '{deploymentRunId: $deploymentRunId, startCommandDigest: $startCommandDigest, bindAddress: $bindAddress,
              port: $port, coldStartMs: null, isRedeploy: $isRedeploy, observedBy: "runner"}'
        )"
        lp_tel_state_write "${workspace_id}" last-heartbeat-epoch "$(date +%s)"
      fi ;;
    stop)
      # The timer keeps ticking after the service stops. That is the point: a
      # deployment that is down emits no heartbeats, and the silence is what
      # deployment.went_quiet is synthesised from.
      : ;;
  esac
}

cmd_down() {
  local address uptime events

  address="$(deployed_address || true)"
  events="$(lp_tel_events_for "${workspace_id}")"
  uptime="$(lp_deploy_uptime_seconds "${unit_name}")"

  if systemctl is-active --quiet "${unit_name}"; then
    lp_log "stopping ${unit_name}"
    lp_tel_emit "${workspace_id}" deployment.stopped "$(
      jq -nc --argjson uptimeSeconds "${uptime}" \
        '{reason: "removed", exitCode: 0, signal: null, uptimeSeconds: $uptimeSeconds}'
    )"
    lp_tel_state_write "${workspace_id}" stopped-token "$(lp_tel_state_read "${workspace_id}" run-token "")"
    systemctl stop "${unit_name}" || lp_warn "could not stop ${unit_name}"
  fi

  if [[ -d "$(lp_tel_dir_for "${workspace_id}")" ]]; then
    lp_tel_emit "${workspace_id}" deployment.removed "$(
      jq -nc \
        --argjson uptimeTotalSeconds "$(( $(lp_tel_state_read "${workspace_id}" uptime-total 0) + uptime ))" \
        --argjson restartsTotal "$(systemctl show "${unit_name}" -p NRestarts --value 2>/dev/null | grep -E '^[0-9]+$' || printf '0')" \
        '{uptimeTotalSeconds: $uptimeTotalSeconds, restartsTotal: $restartsTotal, reason: "operator"}'
    )"
    lp_log "telemetry for '${workspace_id}' is at ${events} ($(wc -l <"${events}" 2>/dev/null || printf 0) events)"
  fi

  lp_heartbeat_disable "${workspace_id}"
  lp_nft_remove "${workspace_id}"

  if [[ -n "${address}" ]]; then
    lp_deploy_remove_loopback_alias "${address}"
  else
    lp_log "no recorded address for '${workspace_id}'; nothing to unbind"
  fi

  # Teardown removes the whole drop-in directory, which includes the network
  # drop-in written above, so it is deliberately not deleted here first: the
  # address must still be readable from it right up to this point.
  local teardown_args=("${workspace_id}")
  [[ "${keep_data}" == "yes" ]] && teardown_args+=(--keep-data)
  "${LP_HOST_DIR}/lp-teardown-workspace.sh" "${teardown_args[@]}"

  if [[ "${keep_data}" == "yes" ]]; then
    lp_log "keeping telemetry at ${events} as requested"
  else
    lp_log "removing telemetry directory $(lp_tel_dir_for "${workspace_id}")"
    lp_tel_remove "${workspace_id}"
  fi

  lp_heartbeat_remove_templates_if_unused

  lp_log "deployment '${workspace_id}' removed"
}

cmd_list() {
  local file id address port state pack events

  printf '%-24s %-14s %-7s %-10s %-28s %-7s %s\n' WORKSPACE ADDRESS PORT STATE PACK EVENTS URL

  for file in "${LP_UNIT_DIR}"/lp-workspace@*.service.d/"${LP_DEPLOY_DROPIN_NAME}"; do
    [[ -f "${file}" ]] || continue
    id="$(basename -- "$(dirname -- "${file}")")"
    id="${id#lp-workspace@}"
    id="${id%.service.d}"
    address="$(lp_deploy_dropin_field "${file}" lp-address || printf '?')"
    port="$(lp_deploy_dropin_field "${file}" lp-port || printf '?')"
    pack="$(lp_deploy_dropin_field "${file}" lp-pack-id || printf '-')"
    state="$(systemctl is-active "$(lp_unit_for "${id}")" 2>/dev/null || true)"
    events="$(wc -l <"$(lp_tel_events_for "${id}")" 2>/dev/null || printf 0)"
    printf '%-24s %-14s %-7s %-10s %-28s %-7s %s\n' \
      "${id}" "${address}" "${port}" "${state:-unknown}" "${pack:--}" "${events}" \
      "$(lp_deploy_url_for "${address}" "${port}")"
  done
}

case "${command_name}" in
  up) cmd_up ;;
  plan) cmd_plan ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  events) cmd_events ;;
  start|stop|restart) cmd_lifecycle "${command_name}" ;;
  down) cmd_down ;;
  list) cmd_list ;;
  *) lp_die "unknown command '${command_name}' (try --help)" ;;
esac
