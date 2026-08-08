#!/usr/bin/env bash
# One telemetry tick for one deployment. Driven by lp-heartbeat@<id>.timer.
#
# The runner emits the events that happen while it is holding the deployment:
# provisioned, started, healthy, stopped, removed. Everything else in tier 1
# happens when nothing is watching — a crash and a restart, a service that stops
# answering, a destination the sandbox dropped, and above all silence. This is
# what watches.
#
# It runs as root, outside the workspace's sandbox, from a unit that survives
# the deployment. That is the whole design: an emitter that shares the fate of
# the thing it observes cannot report the fate.
#
# Usage:
#   lp-heartbeat.sh <workspace-id>

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lp-deploy-common.sh
source "${script_dir}/lp-deploy-common.sh"

workspace_id="${1-}"
[[ -n "${workspace_id}" ]] || lp_die "usage: lp-heartbeat.sh <workspace-id>"
lp_validate_workspace_id "${workspace_id}"

unit_name="$(lp_unit_for "${workspace_id}")"
dropin_file="$(lp_deploy_dropin_for "${workspace_id}")"

# A torn-down deployment leaves no drop-in. Exiting quietly rather than failing
# keeps a stray timer from filling the journal with errors about a workspace
# that is legitimately gone.
[[ -f "${dropin_file}" ]] || exit 0
[[ -d "$(lp_tel_dir_for "${workspace_id}")" ]] || exit 0

lp_tel_require_jq

address="$(lp_deploy_dropin_field "${dropin_file}" lp-address || printf '')"
port="$(lp_deploy_dropin_field "${dropin_file}" lp-port || printf '')"
health_path="$(lp_deploy_dropin_field "${dropin_file}" lp-health-path || printf '/')"
declared_hosts="$(lp_deploy_dropin_field "${dropin_file}" lp-egress-hosts || printf '')"
start_digest="$(lp_deploy_dropin_field "${dropin_file}" lp-start-digest || printf '')"

interval="$(lp_tel_state_read "${workspace_id}" heartbeat-interval "${LP_HEARTBEAT_INTERVAL_SECONDS}")"
[[ "${interval}" =~ ^[0-9]+$ ]] && [[ "${interval}" -gt 0 ]] || interval="${LP_HEARTBEAT_INTERVAL_SECONDS}"

now_epoch="$(date +%s)"
active_state="$(systemctl is-active "${unit_name}" 2>/dev/null || true)"

unit_property() { systemctl show "${unit_name}" -p "$1" --value 2>/dev/null || printf ''; }

numeric_or_null() {
  local value="$1"
  # systemd reports an unset counter as [not set] or infinity; both are "we do
  # not know", and a consumer must be able to tell that from a real zero.
  [[ "${value}" =~ ^[0-9]+$ ]] && printf '%s' "${value}" || printf 'null'
}

# --- run boundaries --------------------------------------------------------
#
# systemd restarted the service while nothing was holding it: that is a stop and
# a start, and both are moments the contract says must not be inferred from
# traffic later.
stop_reason_from_unit() {
  local result
  result="$(unit_property Result)"
  case "${result}" in
    oom-kill) printf 'oom' ;;
    exit-code|signal|core-dump|watchdog|timeout) printf 'crash' ;;
    *) printf 'operator' ;;
  esac
}

emit_stopped_for_previous_run() {
  local reason uptime status code exit_code signal
  reason="$(stop_reason_from_unit)"
  uptime="$(lp_tel_state_read "${workspace_id}" last-uptime-seconds 0)"

  # ExecMainCode is the CLD_* code: 1 means the process exited and
  # ExecMainStatus is its exit status, 2 means it was killed and the same field
  # is the signal number. Reporting one as the other is how an OOM kill ends up
  # in a corpus as "exited 9".
  status="$(unit_property ExecMainStatus)"
  code="$(unit_property ExecMainCode)"
  exit_code="null"
  signal="null"
  [[ "${code}" == "1" ]] && exit_code="$(numeric_or_null "${status}")"
  [[ "${code}" == "2" ]] && signal="$(numeric_or_null "${status}")"

  lp_tel_emit "${workspace_id}" deployment.stopped "$(
    jq -nc \
      --arg reason "${reason}" \
      --argjson exitCode "${exit_code}" \
      --argjson signal "${signal}" \
      --argjson uptimeSeconds "$(numeric_or_null "${uptime}")" \
      '{reason: $reason, exitCode: $exitCode, signal: $signal, uptimeSeconds: $uptimeSeconds}'
  )"

  lp_tel_state_write "${workspace_id}" uptime-total \
    "$(( $(lp_tel_state_read "${workspace_id}" uptime-total 0) + uptime ))"
}

emit_started_for_current_run() {
  local run_id
  run_id="$(lp_tel_rotate_run_id "${workspace_id}" "$(lp_tel_run_token "${unit_name}")")"

  lp_tel_emit "${workspace_id}" deployment.started "$(
    jq -nc \
      --arg deploymentRunId "${run_id}" \
      --arg startCommandDigest "${start_digest}" \
      --arg bindAddress "${address}" \
      --argjson port "$(numeric_or_null "${port}")" \
      --argjson restarts "$(numeric_or_null "$(unit_property NRestarts)")" \
      '{deploymentRunId: $deploymentRunId, startCommandDigest: $startCommandDigest, bindAddress: $bindAddress, port: $port,
        coldStartMs: null, isRedeploy: false, restartsTotal: $restarts,
        observedBy: "supervisor-restart"}'
  )"
}

current_token="$(lp_tel_run_token "${unit_name}")"
stored_token="$(lp_tel_state_read "${workspace_id}" run-token "")"
stopped_token="$(lp_tel_state_read "${workspace_id}" stopped-token "")"

# One run boundary, one stop event, whoever noticed it first. A crash is
# typically seen twice — once by the tick that finds the unit down and again by
# the tick that finds it back up under a new token — and the run it belongs to
# is what makes the second sighting recognisable as the same fact.
if [[ "${active_state}" == "active" ]]; then
  if [[ -n "${current_token}" && "${current_token}" != "${stored_token}" ]]; then
    if [[ -n "${stored_token}" && "${stopped_token}" != "${stored_token}" ]]; then
      emit_stopped_for_previous_run
    fi
    emit_started_for_current_run
  fi
elif [[ -n "${stored_token}" && "${stopped_token}" != "${stored_token}" ]]; then
  emit_stopped_for_previous_run
  lp_tel_state_write "${workspace_id}" stopped-token "${stored_token}"
fi

# --- the absence -----------------------------------------------------------
#
# Synthesised here rather than left to the control plane, because a file of
# newline-delimited JSON has no clock of its own: nothing downstream can tell a
# deployment that stopped emitting from a deployment that was never deployed
# unless something on this side notices the gap and writes it down.
last_heartbeat="$(lp_tel_state_read "${workspace_id}" last-heartbeat-epoch "")"
quiet_reported="$(lp_tel_state_read "${workspace_id}" quiet-reported-for "")"

if [[ -n "${last_heartbeat}" ]]; then
  gap="$(( now_epoch - last_heartbeat ))"
  missed="$(( gap / interval ))"
  if [[ "${missed}" -ge "${LP_QUIET_AFTER_INTERVALS}" && "${quiet_reported}" != "${last_heartbeat}" ]]; then
    lp_tel_emit "${workspace_id}" deployment.went_quiet "$(
      jq -nc \
        --arg lastHeartbeatAt "$(date -u -d "@${last_heartbeat}" +%Y-%m-%dT%H:%M:%S.000Z)" \
        --argjson missedIntervals "${missed}" \
        --argjson intervalSeconds "${interval}" \
        --arg unitState "${active_state:-unknown}" \
        '{lastHeartbeatAt: $lastHeartbeatAt, missedIntervals: $missedIntervals, intervalSeconds: $intervalSeconds,
          unitState: $unitState, synthesisedBy: "deployment-host"}'
    )"
    lp_tel_state_write "${workspace_id}" quiet-reported-for "${last_heartbeat}"
  fi
fi

# --- the heartbeat ---------------------------------------------------------
if [[ "${active_state}" == "active" ]]; then
  uptime_seconds="$(lp_deploy_uptime_seconds "${unit_name}")"
  lp_tel_state_write "${workspace_id}" last-uptime-seconds "${uptime_seconds}"

  lp_tel_emit "${workspace_id}" deployment.heartbeat "$(
    jq -nc \
      --argjson uptimeSeconds "$(numeric_or_null "${uptime_seconds}")" \
      --argjson memoryCurrentBytes "$(numeric_or_null "$(unit_property MemoryCurrent)")" \
      --argjson tasksCurrent "$(numeric_or_null "$(unit_property TasksCurrent)")" \
      --argjson ipIngressBytes "$(numeric_or_null "$(unit_property IPIngressBytes)")" \
      --argjson ipEgressBytes "$(numeric_or_null "$(unit_property IPEgressBytes)")" \
      --argjson restartsSinceStart "$(numeric_or_null "$(unit_property NRestarts)")" \
      '{uptimeSeconds: $uptimeSeconds, memoryCurrentBytes: $memoryCurrentBytes, tasksCurrent: $tasksCurrent,
        ipIngressBytes: $ipIngressBytes, ipEgressBytes: $ipEgressBytes, restartsSinceStart: $restartsSinceStart}'
  )"

  lp_tel_state_write "${workspace_id}" last-heartbeat-epoch "${now_epoch}"
  lp_tel_state_write "${workspace_id}" quiet-reported-for ""
fi

# --- health ----------------------------------------------------------------
#
# The runner probes once, to decide whether the deploy succeeded. A deployment
# that answered at deploy time and stopped answering an hour later is the more
# interesting event, and it is only visible if something keeps probing.
if [[ "${active_state}" == "active" && -n "${address}" && -n "${port}" ]]; then
  probe_url="$(lp_deploy_url_for "${address}" "${port}")${health_path}"
  status_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${probe_url}" 2>/dev/null || printf '000')"
  failures="$(lp_tel_state_read "${workspace_id}" health-failures 0)"
  unhealthy_since="$(lp_tel_state_read "${workspace_id}" unhealthy-since "")"

  if [[ "${status_code}" =~ ^[23] ]]; then
    if [[ "${failures}" -gt 0 ]]; then
      recovered_after="$(( (now_epoch - ${unhealthy_since:-${now_epoch}}) * 1000 ))"
      lp_tel_emit "${workspace_id}" deployment.healthy "$(
        jq -nc \
          --arg probePath "${health_path}" \
          --argjson statusCode "$(( 10#${status_code} ))" \
          --argjson timeToHealthyMs "${recovered_after}" \
          --argjson attempts "${failures}" \
          '{probePath: $probePath, statusCode: $statusCode, timeToHealthyMs: $timeToHealthyMs, attempts: $attempts, recoveredFromUnhealthy: true}'
      )"
    fi
    lp_tel_state_write "${workspace_id}" health-failures 0
    lp_tel_state_write "${workspace_id}" unhealthy-since ""
  else
    failures="$(( failures + 1 ))"
    [[ -n "${unhealthy_since}" ]] || unhealthy_since="${now_epoch}"
    lp_tel_state_write "${workspace_id}" health-failures "${failures}"
    lp_tel_state_write "${workspace_id}" unhealthy-since "${unhealthy_since}"

    lp_tel_emit "${workspace_id}" deployment.unhealthy "$(
      jq -nc \
        --arg probePath "${health_path}" \
        --argjson lastStatusCode "$(( 10#${status_code} ))" \
        --argjson consecutiveFailures "${failures}" \
        --argjson unhealthyForMs "$(( (now_epoch - unhealthy_since) * 1000 ))" \
        '{probePath: $probePath, lastStatusCode: (if $lastStatusCode == 0 then null else $lastStatusCode end),
          consecutiveFailures: $consecutiveFailures, unhealthyForMs: $unhealthyForMs}'
    )"
  fi
fi

# --- what the sandbox dropped ----------------------------------------------
#
# Aggregated per destination with a count, because a pack retrying a blocked
# host in a loop must arrive as one event with a number on it and not as ten
# thousand events. `declaredInManifest` is what separates the two readings of
# this event: an undeclared destination is a security signal, and a declared one
# that is being dropped is a requirements signal with an obvious repair — the
# usual cause being a DNS record that moved after the allow list was resolved.
cursor_file="$(lp_tel_state_dir_for "${workspace_id}")/journal-cursor"
log_match="${LP_NFT_LOG_PREFIX} ${workspace_id}: "

if [[ -s "${cursor_file}" ]]; then
  denied_lines="$(journalctl -k --after-cursor "$(cat -- "${cursor_file}")" --no-pager -o cat 2>/dev/null | grep -F "${log_match}" || true)"
else
  denied_lines="$(journalctl -k --since "@$(lp_tel_state_read "${workspace_id}" first-seen-epoch "${now_epoch}")" --no-pager -o cat 2>/dev/null | grep -F "${log_match}" || true)"
fi

journalctl -k -n 1 --show-cursor --no-pager -o cat 2>/dev/null \
  | sed -n 's/^-- cursor: //p' >"${cursor_file}.next" || true
[[ -s "${cursor_file}.next" ]] && mv -- "${cursor_file}.next" "${cursor_file}"
rm -f -- "${cursor_file}.next"

if [[ -n "${denied_lines}" ]]; then
  # Resolved now rather than reused from deploy time: the interesting case is a
  # declared host whose address changed underneath a fixed allow list, and that
  # is only visible by re-resolving at the moment of the denial.
  declared_map=""
  if [[ -n "${declared_hosts}" ]]; then
    for declared_host in ${declared_hosts//,/ }; do
      # Both families, unlike the allow list, which is IPv4-only. A declared
      # host dialled over IPv6 is denied by the unit's blanket IPv6 deny, and
      # reporting that as an undeclared destination would hide the one reading
      # that matters: the pack asked for something it was promised.
      while read -r resolved; do
        [[ -n "${resolved}" ]] || continue
        declared_map+="$(lp_ipv6_expand "${resolved}") ${declared_host}"$'\n'
      done < <(getent ahosts "${declared_host}" 2>/dev/null | awk '{print $1}' | sort -u)
    done
  fi

  while read -r destination count; do
    [[ -n "${destination}" ]] || continue
    denied_address="${destination%%|*}"
    denied_port="${destination##*|}"
    matched_host="$(awk -v a="$(lp_ipv6_expand "${denied_address}")" '$1 == a {print $2; exit}' <<<"${declared_map}")"

    lp_tel_emit "${workspace_id}" egress.denied "$(
      jq -nc \
        --arg host "${matched_host}" \
        --arg address "${denied_address}" \
        --argjson port "$(numeric_or_null "${denied_port}")" \
        --argjson count "${count}" \
        '{destination: {host: (if $host == "" then null else $host end), address: $address, port: $port},
          deniedBy: "ip-filter", count: $count,
          declaredInManifest: ($host != ""),
          observedBy: "netfilter-log"}'
    )"
  done < <(
    # Both address families: the log rule is in an `inet` chain, so an IPv6
    # destination reaches it too, and an IPv4-only pattern silently truncated
    # one into a plausible-looking number.
    grep -oE 'DST=[0-9a-fA-F.:]+|DPT=[0-9]+' <<<"${denied_lines}" \
      | paste - - \
      | sed 's/DST=//; s/\tDPT=/|/' \
      | sort | uniq -c | awk '{print $2, $1}'
  )
fi
