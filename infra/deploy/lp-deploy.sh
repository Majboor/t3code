#!/usr/bin/env bash
# Deploy runner for isolated workspaces.
#
# Takes a workspace id and a directory containing an already-built application,
# provisions the workspace using infra/host/lp-provision-workspace.sh, installs
# the build, starts it under the hardened lp-workspace@.service unit, and
# reports the local URL it answers on.
#
# This layer owns exactly three things the isolation layer below it does not:
# where the build goes, what command starts it, and which addresses the running
# service may exchange packets with. Everything else — the user, the sandbox,
# the resource caps — is inherited, not restated.
#
# The workload never runs as root. Root is required to run *this* script
# (creating users, writing units, adding loopback aliases all need it) and the
# `up` path asserts the resulting service's identity before reporting success.
#
# Usage:
#   lp-deploy.sh up <workspace-id> --from <dir> --command <cmd> [options]
#   lp-deploy.sh status|logs|start|stop|restart|down <workspace-id> [options]
#   lp-deploy.sh list

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lp-deploy-common.sh
source "${script_dir}/lp-deploy-common.sh"

usage() {
  cat <<'EOF'
Usage: lp-deploy.sh <command> [arguments]

Commands:
  up <id> --from <dir> --command <cmd>   Provision, install, start, report a URL
  status <id>                            Unit state, URL, reachability probes
  logs <id> [--lines N] [--follow]       Journal for the workspace's service
  start <id> | stop <id> | restart <id>  Lifecycle without touching the build
  down <id> [--keep-data]                Stop and remove everything created
  list                                   Every deployment on this host

Options for `up`:
  --from <dir>           Directory containing the built application (required)
  --command <cmd>        Command that starts it, run inside the installed app
                         directory (required)
  --health-path <path>   Path polled to decide the deploy succeeded (default /)
  --egress <mode>        public (internet, no loopback/private/host) or none
                         (nothing but the workspace's own address). Default public.
  --port <port>          Pin the TCP port instead of allocating one
  --memory-max <value>   Passed through to provisioning (default 512M)
  --tasks-max <count>    Passed through to provisioning (default 64)
  --max-size-mb <mb>     Refuse builds larger than this (default 2048)
  --health-timeout <s>   Seconds to wait for the first successful probe (default 30)

The application is told where to listen through HOST, PORT, LP_BIND_ADDRESS and
LP_PORT. It MUST bind the address it is given: `up` fails the deploy if the
service turns out to be reachable from outside the host.
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
start_command=""
health_path="/"
egress_mode="public"
requested_port=""
memory_max=""
tasks_max=""
max_size_mb="${LP_DEPLOY_MAX_SIZE_MB_DEFAULT}"
health_timeout="30"
log_lines="200"
follow_logs="no"
keep_data="no"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --from) [[ $# -ge 2 ]] || lp_die "--from requires a directory"; source_dir="$2"; shift 2 ;;
    --command) [[ $# -ge 2 ]] || lp_die "--command requires a value"; start_command="$2"; shift 2 ;;
    --health-path) [[ $# -ge 2 ]] || lp_die "--health-path requires a value"; health_path="$2"; shift 2 ;;
    --egress) [[ $# -ge 2 ]] || lp_die "--egress requires a value"; egress_mode="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || lp_die "--port requires a value"; requested_port="$2"; shift 2 ;;
    --memory-max) [[ $# -ge 2 ]] || lp_die "--memory-max requires a value"; memory_max="$2"; shift 2 ;;
    --tasks-max) [[ $# -ge 2 ]] || lp_die "--tasks-max requires a value"; tasks_max="$2"; shift 2 ;;
    --max-size-mb) [[ $# -ge 2 ]] || lp_die "--max-size-mb requires a value"; max_size_mb="$2"; shift 2 ;;
    --health-timeout) [[ $# -ge 2 ]] || lp_die "--health-timeout requires a value"; health_timeout="$2"; shift 2 ;;
    --lines) [[ $# -ge 2 ]] || lp_die "--lines requires a value"; log_lines="$2"; shift 2 ;;
    --follow) follow_logs="yes"; shift ;;
    --keep-data) keep_data="yes"; shift ;;
    -*) lp_die "unknown option '$1' (try --help)" ;;
    *)
      [[ -z "${workspace_id}" ]] || lp_die "unexpected extra argument '$1'"
      workspace_id="$1"; shift ;;
  esac
done

if [[ "${command_name}" != "list" ]]; then
  lp_validate_workspace_id "${workspace_id}"
fi

lp_require_root

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

# Renders the network drop-in.
#
# The template's `IPAddressDeny=any` is the default: an address that matches no
# allow entry is dropped. Everything below is therefore expressed as allows —
# there is no "deny 127.0.0.0/8" line anywhere, because in systemd's model an
# allow entry beats a deny entry outright and a deny for a range already covered
# by an allow does nothing at all. Loopback is blocked here by being *absent*
# from the enumerated allow list, not by being denied.
write_network_dropin() {
  local address="$1" port="$2" mode="$3"
  local dropin_dir
  dropin_dir="$(dirname -- "${dropin_file}")"

  mkdir -p "${dropin_dir}"

  {
    printf '# Generated by lp-deploy.sh for workspace %s. Do not edit by hand.\n' "${workspace_id}"
    printf '# lp-address=%s\n' "${address}"
    printf '# lp-port=%s\n' "${port}"
    printf '# lp-egress=%s\n' "${mode}"
    printf '\n[Service]\n'

    # Placed in a root-owned drop-in rather than the workspace-writable `env`
    # file the template reads, and parsed after it, so a workspace cannot move
    # itself onto another address by editing its own configuration.
    printf 'Environment=LP_WORKSPACE_ID=%s\n' "${workspace_id}"
    printf 'Environment=LP_BIND_ADDRESS=%s\n' "${address}"
    printf 'Environment=LP_PORT=%s\n' "${port}"
    printf 'Environment=HOST=%s\n' "${address}"
    printf 'Environment=PORT=%s\n' "${port}"

    printf '\n# Turns byte counters on so egress can be observed, not just filtered.\n'
    printf 'IPAccounting=yes\n'

    if [[ "${mode}" == "public" ]]; then
      printf '\n# The public IPv4 space, computed as everything minus loopback, the\n'
      printf '# RFC1918 and carrier-grade ranges, link-local (which carries the cloud\n'
      printf '# metadata address), multicast, reserved space, and every address\n'
      printf '# configured on this host. Generated, because the excluded ranges are\n'
      printf '# what a deployment must not reach and the allow list has to be their\n'
      printf '# exact complement.\n'
      lp_deploy_public_allow_prefixes | while read -r prefix; do
        printf 'IPAddressAllow=%s\n' "${prefix}"
      done

      printf '\n# IPv6 is left with no allow entry at all, so the template deny covers\n'
      printf '# it. Computing an IPv6 complement is not worth it here: nothing on this\n'
      printf '# host listens on IPv6, and a dual-stack client falls back to IPv4.\n'

      printf '\n# The stub resolver, or nothing in the workspace can resolve a name.\n'
      printf '# Narrow on purpose: systemd-resolved is the only listener on this\n'
      printf '# address, so a /32 hole here reaches none of the services above.\n'
      printf 'IPAddressAllow=127.0.0.53/32\n'
    fi

    printf '\n# The workspace'"'"'s own address, and the only loopback address it gets.\n'
    printf '# Covers both directions: inbound from the host (which sources packets\n'
    printf '# from this address because of the /32 loopback alias) and the service\n'
    printf '# talking to itself.\n'
    printf 'IPAddressAllow=%s/32\n' "${address}"
  } >"${dropin_file}"

  chmod 0644 "${dropin_file}"
}

install_build() {
  local source="$1"
  local size_mb available_mb

  [[ -d "${source}" ]] || lp_die "--from '${source}' is not a directory"

  size_mb="$(du -sm -- "${source}" | awk '{print $1}')"
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
  local command="$1"
  local run_file="${workspace_dir}/run"

  cat >"${run_file}" <<EOF
#!/usr/bin/env bash
# Generated by lp-deploy.sh for workspace ${workspace_id}. Rewritten on every
# deploy; edits here are lost. The unit's ExecStart points at this file, so it
# is the single seam between the fixed sandbox and the workspace's own command.
set -euo pipefail

cd "\$(dirname -- "\${BASH_SOURCE[0]}")/app"
exec ${command}
EOF

  chown "${user_name}:${user_name}" "${run_file}"
  chmod 0700 "${run_file}"
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
  printf 'egress      %s\n' "$(lp_deploy_dropin_field "${dropin_file}" lp-egress || printf 'unknown')"
  printf 'url         %s\n' "$(lp_deploy_url_for "${address}" "${port}")"
}

# --- commands -------------------------------------------------------------

cmd_up() {
  local address port existing_address existing_port

  [[ -n "${source_dir}" ]] || lp_die "up requires --from <dir>"
  [[ -n "${start_command}" ]] || lp_die "up requires --command <cmd>"
  [[ "${max_size_mb}" =~ ^[0-9]+$ ]] || lp_die "--max-size-mb must be an integer, got '${max_size_mb}'"
  [[ "${health_timeout}" =~ ^[0-9]+$ ]] || lp_die "--health-timeout must be an integer, got '${health_timeout}'"
  case "${egress_mode}" in
    public|none) : ;;
    *) lp_die "--egress must be 'public' or 'none', got '${egress_mode}'" ;;
  esac
  if [[ -n "${requested_port}" ]]; then
    [[ "${requested_port}" =~ ^[0-9]+$ ]] || lp_die "--port must be an integer, got '${requested_port}'"
  fi

  source_dir="$(cd -- "${source_dir}" 2>/dev/null && pwd)" || lp_die "--from '${source_dir}' is not a readable directory"

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

  lp_deploy_ensure_loopback_alias "${address}"
  write_network_dropin "${address}" "${port}" "${egress_mode}"
  systemctl daemon-reload

  install_build "${source_dir}"
  write_run_file "${start_command}"

  lp_log "starting ${unit_name}"
  systemctl restart "${unit_name}" || {
    journalctl -u "${unit_name}" -n 40 --no-pager || true
    lp_die "${unit_name} failed to start"
  }

  local url="$(lp_deploy_url_for "${address}" "${port}")${health_path}"
  lp_log "waiting for ${url}"
  if ! lp_deploy_wait_healthy "${url}" "${health_timeout}"; then
    journalctl -u "${unit_name}" -n 40 --no-pager || true
    lp_die "no response from ${url} after ${health_timeout}s"
  fi
  lp_log "healthy"

  assert_not_root
  assert_not_publicly_bound "${port}"

  report
}

cmd_status() {
  require_deployed

  local address port url
  address="$(deployed_address)"
  port="$(deployed_port)"
  url="$(lp_deploy_url_for "${address}" "${port}")"

  report
  printf '\n'
  systemctl show "${unit_name}" \
    -p ActiveState -p SubState -p MainPID -p User -p NRestarts \
    -p MemoryCurrent -p TasksCurrent -p IPAddressDeny -p IPAddressAllow \
    -p IPIngressBytes -p IPEgressBytes

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

cmd_lifecycle() {
  local action="$1"
  require_deployed

  lp_log "${action} ${unit_name}"
  systemctl "${action}" "${unit_name}"
  systemctl is-active "${unit_name}" || true
}

cmd_down() {
  local address

  address="$(deployed_address || true)"

  if systemctl is-active --quiet "${unit_name}"; then
    lp_log "stopping ${unit_name}"
    systemctl stop "${unit_name}" || lp_warn "could not stop ${unit_name}"
  fi

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

  lp_log "deployment '${workspace_id}' removed"
}

cmd_list() {
  local file id address port state

  printf '%-24s %-14s %-7s %-10s %s\n' WORKSPACE ADDRESS PORT STATE URL

  for file in "${LP_UNIT_DIR}"/lp-workspace@*.service.d/"${LP_DEPLOY_DROPIN_NAME}"; do
    [[ -f "${file}" ]] || continue
    id="$(basename -- "$(dirname -- "${file}")")"
    id="${id#lp-workspace@}"
    id="${id%.service.d}"
    address="$(lp_deploy_dropin_field "${file}" lp-address || printf '?')"
    port="$(lp_deploy_dropin_field "${file}" lp-port || printf '?')"
    state="$(systemctl is-active "$(lp_unit_for "${id}")" 2>/dev/null || true)"
    printf '%-24s %-14s %-7s %-10s %s\n' \
      "${id}" "${address}" "${port}" "${state:-unknown}" "$(lp_deploy_url_for "${address}" "${port}")"
  done
}

case "${command_name}" in
  up) cmd_up ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  start|stop|restart) cmd_lifecycle "${command_name}" ;;
  down) cmd_down ;;
  list) cmd_list ;;
  *) lp_die "unknown command '${command_name}' (try --help)" ;;
esac
