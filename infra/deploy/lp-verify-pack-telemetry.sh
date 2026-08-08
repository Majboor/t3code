#!/usr/bin/env bash
# Prove the pack path and the telemetry contract end to end, on a real host.
#
# Builds a throwaway `.pack`, deploys it through lp-deploy.sh — the same code
# path a real pack takes — and then produces the four pieces of evidence that
# actually settle whether any of this works:
#
#   1. the manifest decided the deploy: start command, port, health path and the
#      egress allow list all came out of pack.json and none off the command line;
#   2. a manifest the host cannot honour is refused, with the field named;
#   3. the declared egress was applied — a denied destination dialled from
#      *inside* the service, and the same destination dialled from a root shell
#      in the same run, so a block cannot be confused with a service being down;
#   4. the tier-1 event stream, including the one event that is an absence.
#
# Usage:
#   lp-verify-pack-telemetry.sh <workspace-id> [--keep]
#
# The workspace id must be a throwaway: this overwrites whatever is deployed
# there, and removes it again unless --keep is passed.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lp-deploy-common.sh
source "${script_dir}/lp-deploy-common.sh"

workspace_id=""
keep="no"
# Short enough that three missed ticks is a wait an operator will sit through,
# which is the only reason the interval is configurable at all.
heartbeat_interval=15

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) keep="yes"; shift ;;
    -h|--help) printf 'Usage: lp-verify-pack-telemetry.sh <workspace-id> [--keep]\n'; exit 0 ;;
    -*) lp_die "unknown option '$1'" ;;
    *)
      [[ -z "${workspace_id}" ]] || lp_die "unexpected extra argument '$1'"
      workspace_id="$1"; shift ;;
  esac
done

lp_require_root
lp_validate_workspace_id "${workspace_id}"

unit_name="$(lp_unit_for "${workspace_id}")"
events_file="$(lp_tel_events_for "${workspace_id}")"

banner() { printf '\n########## %s ##########\n' "$*"; }

# The denied target is discovered rather than hardcoded, so the evidence is
# about a service this host is actually running.
denied_target="$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep '^127\.0\.0\.1:' | sort -u -t: -k2 -n | head -1)"
[[ -n "${denied_target}" ]] || lp_die "no loopback service found to use as a denied target"

work_dir="$(mktemp -d -t lp-packprobe-XXXXXX)"
trap 'rm -rf -- "${work_dir}"' EXIT
pack_dir="${work_dir}/probe.pack"
mkdir -p "${pack_dir}"

# --- the throwaway pack ---------------------------------------------------

cat >"${pack_dir}/server.js" <<PROBE_EOF
// Throwaway probe pack. Serves a health path on the address it was given, and
// keeps dialling one destination it is allowed to reach and one it is not, so
// that both halves of the egress rule are exercised by the workload itself
// rather than asserted about it.
const http = require("node:http");
const net = require("node:net");

const host = process.env.HOST;
const port = Number(process.env.PORT);
const deniedHost = process.env.PROBE_DENIED_HOST;
const deniedPort = Number(process.env.PROBE_DENIED_PORT);

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(\`probe ok uid=\${process.getuid()} path=\${req.url}\n\`);
  })
  .listen(port, host, () => console.log(\`listening on \${host}:\${port} as uid \${process.getuid()}\`));

function dial(label, target, targetPort) {
  const started = Date.now();
  const socket = net.connect({ host: target, port: targetPort });
  socket.setTimeout(4000);
  socket.on("connect", () => {
    console.log(\`\${label} REACHED \${target}:\${targetPort} in \${Date.now() - started}ms\`);
    socket.destroy();
  });
  socket.on("timeout", () => {
    console.log(\`\${label} BLOCKED \${target}:\${targetPort} (timed out after \${Date.now() - started}ms)\`);
    socket.destroy();
  });
  socket.on("error", (err) => {
    console.log(\`\${label} BLOCKED \${target}:\${targetPort} (\${err.code})\`);
  });
}

setInterval(() => {
  dial("declared", "example.com", 80);
  dial("undeclared", deniedHost, deniedPort);
}, 10_000);
PROBE_EOF

cat >"${pack_dir}/handover.md" <<'PROBE_EOF'
# Handover

Throwaway pack used by `lp-verify-pack-telemetry.sh`. It exists to be deployed,
observed and removed inside one script run. Nothing here is a real capability.
PROBE_EOF

cat >"${pack_dir}/pack.json" <<PROBE_EOF
{
  "formatVersion": "2.0",
  "identity": {
    "id": "pack_lp_packprobe",
    "name": "lp-packprobe",
    "version": "0.1.0",
    "displayName": "Deploy runner telemetry probe",
    "summary": "Throwaway pack that exercises the deploy runner's manifest and telemetry paths.",
    "publisher": { "type": "user", "handle": "lp-infra", "displayName": "infra" },
    "license": "NOASSERTION"
  },
  "provenance": {
    "workspace": { "workspaceKeyId": "wsk_probe" },
    "extractedAt": "2026-08-08T00:00:00.000Z",
    "extractedBy": { "type": "agent", "provider": "claudeAgent" },
    "handover": { "path": "handover.md", "summary": "Throwaway probe pack; see the file." }
  },
  "capability": { "does": "Answers a health path and dials two destinations on a timer." },
  "knowledge": {},
  "requirements": {
    "environment": [
      {
        "name": "PROBE_DENIED_HOST",
        "purpose": "A host address the sandbox is expected to block.",
        "secret": false,
        "required": true
      },
      {
        "name": "PROBE_DENIED_PORT",
        "purpose": "The port on that address.",
        "secret": false,
        "required": true
      }
    ]
  },
  "interfaces": [
    {
      "kind": "api",
      "id": "probe-api",
      "title": "Probe API",
      "protocol": "http",
      "serviceId": "web",
      "operations": [
        { "operationId": "healthz", "method": "GET", "path": "/healthz", "summary": "Liveness." }
      ]
    }
  ],
  "runtime": {
    "target": "node",
    "versionRange": ">=20",
    "commands": { "start": { "command": "node server.js", "description": "Serves the probe API." } },
    "services": [
      {
        "id": "web",
        "title": "Probe server",
        "protocol": "http",
        "binding": { "type": "environment", "envVar": "PORT", "defaultPort": 3000 },
        "exposure": "loopback",
        "healthPath": "/healthz"
      }
    ]
  },
  "permissions": {
    "network": [
      { "host": "example.com", "purpose": "The one destination this pack declares.", "required": true }
    ],
    "acceptsInboundNetwork": true
  },
  "verification": {
    "record": {
      "measuredAt": "2026-08-08T00:00:00.000Z",
      "installsAttempted": 0,
      "installsSucceeded": 0,
      "deploymentsAttempted": 0,
      "deploymentsSurviving": 0,
      "cumulativeServiceDays": 0,
      "breakagesCaught": 0,
      "breakagesFixed": 0
    }
  },
  "visibility": { "scope": "workspace", "workspaceKeyId": "wsk_probe" },
  "integration": { "prompt": "Do not integrate this. It is a probe." }
}
PROBE_EOF

cat >"${work_dir}/probe.env" <<PROBE_EOF
PROBE_DENIED_HOST=${denied_target%:*}
PROBE_DENIED_PORT=${denied_target##*:}
PROBE_EOF

# A second manifest that asks for four things this host cannot give, to show
# what refusal looks like. Kept beside the good one so the difference between
# them is the only variable.
mkdir -p "${work_dir}/unhonourable.pack"
cp -- "${pack_dir}/server.js" "${pack_dir}/handover.md" "${work_dir}/unhonourable.pack/"
jq '
  .permissions.network = [{ "host": "*.stripe.com", "purpose": "A wildcard nothing can enumerate." }]
  | .permissions.elevated = [{ "capability": "docker-socket", "justification": "It wants the daemon." }]
  | .permissions.filesystem = [{ "root": "absolute", "path": "/etc", "access": "read", "purpose": "It wants the host." }]
  | .runtime.services[0].binding = { "type": "dynamic" }
' "${pack_dir}/pack.json" >"${work_dir}/unhonourable.pack/pack.json"

# --- 1. the manifest decides the deploy -----------------------------------

banner "PLAN: WHAT THE MANIFEST DECIDES"
"${script_dir}/lp-deploy.sh" plan --pack "${pack_dir}" --env-file "${work_dir}/probe.env"

banner "REFUSAL: A MANIFEST THIS HOST CANNOT HONOUR"
if "${script_dir}/lp-deploy.sh" plan --pack "${work_dir}/unhonourable.pack" --env-file "${work_dir}/probe.env"; then
  lp_warn "the unhonourable pack was accepted; that is a bug in lp-pack.sh"
fi

# --- 2. deploy -------------------------------------------------------------

banner "DEPLOY"
"${script_dir}/lp-deploy.sh" up "${workspace_id}" \
  --pack "${pack_dir}" \
  --env-file "${work_dir}/probe.env" \
  --environment development \
  --memory-max 256M \
  --tasks-max 32 \
  --heartbeat-interval "${heartbeat_interval}" \
  --health-timeout 60

banner "EFFECTIVE FILTER ON THE UNIT"
systemctl show "${unit_name}" -p IPAddressDeny -p IPAddressAllow -p IPAccounting | tr ' ' '\n'

banner "EGRESS OBSERVATION TABLE"
nft list table inet "$(lp_nft_table_for "${workspace_id}")" 2>&1 || true

lp_log "letting the probe run for $((heartbeat_interval * 3))s so it dials both destinations and the timer ticks"
sleep "$((heartbeat_interval * 3))"

# --- 3. the egress evidence, with its control -----------------------------

banner "FROM INSIDE THE SERVICE"
journalctl -u "${unit_name}" --since "-3 min" --no-pager --output cat | tail -20

banner "CONTROL: THE SAME TARGET FROM A ROOT SHELL, THIS RUN"
if curl -sS -o /dev/null --max-time 4 "http://${denied_target}/" >/dev/null 2>&1; then
  printf 'root shell -> %-24s answered\n' "${denied_target}"
else
  printf 'root shell -> %-24s did not answer to a bare GET (it is reachable; see the connect below)\n' "${denied_target}"
fi
printf 'root shell -> %-24s tcp connect ' "${denied_target}"
if timeout 4 bash -c "</dev/tcp/${denied_target%:*}/${denied_target##*:}" 2>/dev/null; then
  printf 'succeeded\n'
else
  printf 'FAILED (the control is invalid — nothing is listening there)\n'
fi

banner "INGRESS"
address="$(lp_deploy_dropin_field "$(lp_deploy_dropin_for "${workspace_id}")" lp-address)"
port="$(lp_deploy_dropin_field "$(lp_deploy_dropin_for "${workspace_id}")" lp-port)"
printf 'from root shell to %s:%s -> ' "${address}" "${port}"
curl -fsS -o /dev/null --max-time 4 "http://${address}:${port}/healthz" && printf 'reachable\n' || printf 'NOT reachable\n'
printf 'from root shell to 127.0.0.1:%s -> ' "${port}"
curl -fsS -o /dev/null --max-time 4 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1 \
  && printf 'REACHABLE (filter not in force)\n' || printf 'blocked\n'

# --- 4. a crash nobody was holding ----------------------------------------
#
# The supervisor restarts it; no runner is involved and nothing asked for the
# restart. If the boundary is only recorded when an operator drives it, every
# crash in production merges into the run before it.
banner "CRASH: KILLING THE MAIN PROCESS AND LETTING THE SUPERVISOR RESTART IT"
main_pid="$(systemctl show "${unit_name}" -p MainPID --value)"
printf 'killing pid %s with SIGKILL\n' "${main_pid}"
kill -9 "${main_pid}"
sleep "$((heartbeat_interval * 2 + 8))"
systemctl start "$(lp_heartbeat_unit_for "${workspace_id}")" || true
jq -r 'select(.type == "deployment.stopped" or .type == "deployment.started")
       | "\(.occurredAt)  \(.type)  \(.payload.reason // .payload.observedBy)  exit=\(.payload.exitCode)  signal=\(.payload.signal)  run=\(.deployment.deploymentRunId)"' \
  "${events_file}"

# --- 5. the absence --------------------------------------------------------

banner "SILENCE: STOPPING THE SERVICE AND WAITING OUT ${LP_QUIET_AFTER_INTERVALS} INTERVALS"
"${script_dir}/lp-deploy.sh" stop "${workspace_id}"
sleep "$(( heartbeat_interval * (LP_QUIET_AFTER_INTERVALS + 1) + 5 ))"
# The timer fires on its own schedule; this only makes the wait deterministic.
systemctl start "$(lp_heartbeat_unit_for "${workspace_id}")" || true

banner "EMITTED EVENT STREAM"
"${script_dir}/lp-deploy.sh" events "${workspace_id}" --lines 500

banner "EVENT TYPES EMITTED"
jq -r '.type' "${events_file}" | sort | uniq -c | sort -rn

if [[ "${keep}" == "yes" ]]; then
  lp_log "keeping '${workspace_id}'; remove it with: lp-deploy.sh down ${workspace_id}"
  exit 0
fi

banner "TEARDOWN"
"${script_dir}/lp-deploy.sh" down "${workspace_id}"

banner "WHAT IS LEFT"
printf 'lp- users:   %s\n' "$(getent passwd | grep -c '^lp-' || true)"
printf 'lp- units:   %s\n' "$(find "${LP_UNIT_DIR}" -maxdepth 1 -name 'lp-*' | wc -l)"
printf 'lp- paths:   %s\n' "$(find "${LP_ROOT}" -mindepth 1 -maxdepth 1 -name 'lp-*' 2>/dev/null | wc -l)"
printf 'nft tables:  %s\n' "$(nft list tables 2>/dev/null | grep -c 'lp_egress' || true)"
printf 'telemetry:   %s\n' "$([[ -d "${LP_TELEMETRY_ROOT}" ]] && printf '%s' "$(ls -A "${LP_TELEMETRY_ROOT}" | wc -l)" || printf 'root removed')"
printf 'loopback:    %s\n' "$(ip -4 -o addr show dev lo | wc -l) address(es)"
