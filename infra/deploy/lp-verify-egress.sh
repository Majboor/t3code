#!/usr/bin/env bash
# Prove the network filter holds, from inside a real deployment.
#
# Deploys a throwaway probe application through lp-deploy.sh — the same code
# path a real pack takes — and has it attempt connections to the services this
# host actually exposes on loopback. Running the same attempts from a root shell
# would prove nothing: the filter is attached to the service's cgroup, so it
# only exists for processes systemd started inside it.
#
# Two controls make the denials meaningful:
#   * the same targets are dialled from outside the sandbox and reported, so a
#     blocked connection cannot be explained away as "nothing is listening";
#   * the probe's own address must stay reachable, so a blocked connection
#     cannot be explained away as "the network is broken".
#
# Usage:
#   lp-verify-egress.sh <workspace-id> [--egress public|none]
#
# The workspace id must be a throwaway: this overwrites whatever is deployed
# there.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lp-deploy-common.sh
source "${script_dir}/lp-deploy-common.sh"

workspace_id=""
egress_mode="public"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --egress) [[ $# -ge 2 ]] || lp_die "--egress requires a value"; egress_mode="$2"; shift 2 ;;
    -h|--help) printf 'Usage: lp-verify-egress.sh <workspace-id> [--egress public|none]\n'; exit 0 ;;
    -*) lp_die "unknown option '$1'" ;;
    *)
      [[ -z "${workspace_id}" ]] || lp_die "unexpected extra argument '$1'"
      workspace_id="$1"; shift ;;
  esac
done

lp_require_root
lp_validate_workspace_id "${workspace_id}"

unit_name="$(lp_unit_for "${workspace_id}")"
dropin_file="$(lp_deploy_dropin_for "${workspace_id}")"

# --- targets --------------------------------------------------------------
# Discovered rather than hardcoded, so the evidence is about the services this
# host is running right now and not a list that rotted.
mapfile -t loopback_targets < <(
  ss -ltnH 2>/dev/null \
    | awk '{print $4}' \
    | grep '^127\.0\.0\.1:' \
    | sort -u -t: -k2 -n \
    | head -6
)

public_address="$(ip -4 -o addr show scope global 2>/dev/null | awk 'NR==1 {split($4, a, "/"); print a[1]}')"
docker_bridge="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 ~ /^(docker|br-)/ {split($4, a, "/"); print a[1]; exit}')"

probe_dir="$(mktemp -d -t lp-egress-probe-XXXXXX)"
trap 'rm -rf -- "${probe_dir}"' EXIT

{
  for target in "${loopback_targets[@]}"; do
    printf 'loopback-service\t%s\n' "${target}"
  done
  # Anything bound to 0.0.0.0 on this host is also reachable at its public
  # address, which is not loopback — so blocking loopback alone would leave the
  # same services one hop away.
  [[ -n "${public_address}" ]] && printf 'host-public-address\t%s:3773\n' "${public_address}"
  [[ -n "${docker_bridge}" ]] && printf 'docker-bridge\t%s:9090\n' "${docker_bridge}"
} >"${probe_dir}/denied-targets.tsv"

cat >"${probe_dir}/start.sh" <<'PROBE_EOF'
#!/usr/bin/env bash
# Egress probe. Reports once, then serves HTTP on its own address so the unit is
# a genuine long-lived deployment rather than a one-shot script.
set -uo pipefail

banner() { printf '\n=== %s ===\n' "$*"; }

# Reports a connection that MUST fail. A success here is a filter failure and is
# labelled as such rather than passing quietly.
expect_blocked() {
  local label="$1" endpoint="$2" output status
  output="$(curl -sS -o /dev/null --max-time 4 "http://${endpoint}/" 2>&1)"
  status=$?
  if [[ ${status} -eq 0 ]]; then
    printf 'FAIL(reachable) %-22s %-24s :: connection succeeded\n' "${label}" "${endpoint}"
  else
    printf 'BLOCKED         %-22s %-24s :: exit=%s :: %s\n' "${label}" "${endpoint}" "${status}" "${output}"
  fi
}

expect_reachable() {
  local label="$1" url="$2" output status
  output="$(curl -sS -o /dev/null --max-time 8 "${url}" 2>&1)"
  status=$?
  if [[ ${status} -eq 0 ]]; then
    printf 'OK              %-22s %s\n' "${label}" "${url}"
  else
    printf 'UNREACHABLE     %-22s %s :: exit=%s :: %s\n' "${label}" "${url}" "${status}" "${output}"
  fi
}

banner "IDENTITY"
id
printf 'bind address: %s:%s\n' "${LP_BIND_ADDRESS}" "${LP_PORT}"

# Started before the probes so the deploy runner's health check does not have to
# wait for them.
python3 -m http.server --bind "${LP_BIND_ADDRESS}" "${LP_PORT}" &
server_pid=$!
sleep 2

banner "HOST SERVICES ON LOOPBACK AND LOCAL INTERFACES (must be denied)"
while IFS=$'\t' read -r label endpoint; do
  [[ -n "${endpoint}" ]] || continue
  expect_blocked "${label}" "${endpoint}"
done <"./denied-targets.tsv"

banner "OWN ADDRESS (must stay reachable — proves the probe is not simply offline)"
expect_reachable "self" "http://${LP_BIND_ADDRESS}:${LP_PORT}/"

banner "OUTBOUND INTERNET AND DNS"
printf 'resolve example.com -> '
getent hosts example.com 2>&1 | head -1 || printf 'FAILED\n'
expect_reachable "public https" "https://1.1.1.1/"

printf '\nLP-EGRESS-CHECKS-COMPLETE\n'

# Hand the process over to the HTTP server so the unit stays up for inspection.
wait "${server_pid}"
PROBE_EOF

chmod 0755 "${probe_dir}/start.sh"

lp_log "deploying egress probe to workspace '${workspace_id}' (egress=${egress_mode})"
"${script_dir}/lp-deploy.sh" up "${workspace_id}" \
  --from "${probe_dir}" \
  --command 'bash ./start.sh' \
  --egress "${egress_mode}" \
  --tasks-max 32 \
  --memory-max 256M \
  --health-timeout 60

for _ in $(seq 1 30); do
  if journalctl -u "${unit_name}" --since "-3 min" --no-pager 2>/dev/null | grep -q 'LP-EGRESS-CHECKS-COMPLETE'; then
    break
  fi
  sleep 1
done

address="$(lp_deploy_dropin_field "${dropin_file}" lp-address)"
port="$(lp_deploy_dropin_field "${dropin_file}" lp-port)"

printf '\n########## EFFECTIVE FILTER ON THE UNIT ##########\n'
systemctl show "${unit_name}" -p IPAddressDeny -p IPAddressAllow -p IPAccounting | tr ' ' '\n'

printf '\n########## CONTROL: SAME TARGETS FROM OUTSIDE THE SANDBOX ##########\n'
while IFS=$'\t' read -r label endpoint; do
  [[ -n "${endpoint}" ]] || continue
  if curl -sS -o /dev/null --max-time 4 "http://${endpoint}/" >/dev/null 2>&1; then
    printf 'root shell: %-22s %-24s answered\n' "${label}" "${endpoint}"
  else
    printf 'root shell: %-22s %-24s did not answer (see note)\n' "${label}" "${endpoint}"
  fi
done <"${probe_dir}/denied-targets.tsv"

printf '\n########## INGRESS ##########\n'
printf 'from root shell to %s:%s -> ' "${address}" "${port}"
curl -fsS -o /dev/null --max-time 4 "http://${address}:${port}/" && printf 'reachable\n' || printf 'NOT reachable\n'
printf 'from root shell to 127.0.0.1:%s -> ' "${port}"
curl -fsS -o /dev/null --max-time 4 "http://127.0.0.1:${port}/" >/dev/null 2>&1 \
  && printf 'REACHABLE (filter not in force)\n' || printf 'blocked\n'

printf '\n########## PROBE EVIDENCE ##########\n'
journalctl -u "${unit_name}" --since "-5 min" --no-pager --output cat
