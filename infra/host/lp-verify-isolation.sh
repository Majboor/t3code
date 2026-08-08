#!/usr/bin/env bash
# Prove the sandbox actually holds, from inside a running workspace service.
#
# Assertions about hardening are worthless unless they are executed in the same
# context the workload runs in, so every check here is performed by the
# workspace's own `run` executable under the hardened unit — not by root over
# SSH, and not by `su` into the account (which would bypass the systemd
# sandbox entirely and produce a misleadingly weak result).
#
# Usage:
#   lp-verify-isolation.sh <probe-workspace-id> <neighbour-workspace-id>
#
# Both workspaces must already be provisioned. This script overwrites the probe
# workspace's `run` file, so point it only at a throwaway workspace.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lp-common.sh
source "${script_dir}/lp-common.sh"

probe_id="${1-}"
neighbour_id="${2-}"

[[ -n "${probe_id}" && -n "${neighbour_id}" ]] || lp_die "usage: lp-verify-isolation.sh <probe-workspace-id> <neighbour-workspace-id>"

lp_require_root
lp_validate_workspace_id "${probe_id}"
lp_validate_workspace_id "${neighbour_id}"

probe_dir="$(lp_dir_for "${probe_id}")"
neighbour_dir="$(lp_dir_for "${neighbour_id}")"
probe_user="$(lp_user_for "${probe_id}")"
neighbour_user="$(lp_user_for "${neighbour_id}")"
unit_name="$(lp_unit_for "${probe_id}")"

[[ -d "${probe_dir}" ]] || lp_die "probe workspace not provisioned: ${probe_dir}"
[[ -d "${neighbour_dir}" ]] || lp_die "neighbour workspace not provisioned: ${neighbour_dir}"

# Plant a secret the probe must fail to read. Without a concrete target, "ls
# denied" could be explained away as the directory simply being empty.
printf 'neighbour-secret-%s\n' "${neighbour_id}" >"${neighbour_dir}/secret.txt"
chown "${neighbour_user}:${neighbour_user}" "${neighbour_dir}/secret.txt"
chmod 0600 "${neighbour_dir}/secret.txt"

# Passed through the unit's EnvironmentFile rather than baked into the run
# script, which keeps the check script identical across runs.
cat >"${probe_dir}/env" <<EOF
LP_NEIGHBOUR_DIR=${neighbour_dir}
EOF

cat >"${probe_dir}/run" <<'PROBE_EOF'
#!/usr/bin/env bash
# Isolation probe. Runs once, reports, then idles so the unit stays long-lived
# and can be inspected while active.
set -uo pipefail

banner() { printf '\n=== %s ===\n' "$*"; }
# Reports the outcome of a command that is EXPECTED to fail. A check that
# succeeds here is a sandbox failure, and is labelled as such rather than
# silently passing.
expect_fail() {
  local label="$1"; shift
  local output status
  output="$("$@" 2>&1)"; status=$?
  if [[ ${status} -eq 0 ]]; then
    printf 'FAIL(sandbox breached) %s :: command succeeded, output: %s\n' "${label}" "${output}"
  else
    printf 'BLOCKED %s :: exit=%s :: %s\n' "${label}" "${status}" "${output}"
  fi
}

banner "IDENTITY"
id
printf 'effective user: %s\n' "$(whoami)"

banner "PRIVILEGE STATE"
grep -E '^(NoNewPrivs|CapEff|CapBnd|Seccomp)' /proc/self/status

banner "CROSS-WORKSPACE READ (must be denied)"
printf 'target: %s\n' "${LP_NEIGHBOUR_DIR}"
expect_fail "list neighbour workspace" ls -la "${LP_NEIGHBOUR_DIR}"
expect_fail "read neighbour secret" cat "${LP_NEIGHBOUR_DIR}/secret.txt"

banner "ROOT HOME READ (must be denied or empty)"
printf 'ls /root -> ' ; ls -a /root 2>&1 | tr '\n' ' ' ; printf '\n'
expect_fail "read /root/.bashrc" cat /root/.bashrc
expect_fail "read shadow file" cat /etc/shadow

banner "PRIVILEGE ESCALATION (must be denied)"
expect_fail "sudo -n id" sudo -n id
expect_fail "su root" su -c id root
# RestrictNamespaces is enforced by seccomp, so a blocked attempt surfaces as
# SIGSYS (exit 159) rather than a permission error. Either way it is blocked.
expect_fail "unshare user namespace" unshare --user --map-root-user id
expect_fail "mount over /etc" mount -t tmpfs none /etc

banner "WRITE OUTSIDE WORKSPACE (must be denied)"
expect_fail "write /etc" touch /etc/lp-should-not-exist
expect_fail "write /usr/local/bin" touch /usr/local/bin/lp-should-not-exist
expect_fail "write /srv/lp-workspaces" touch /srv/lp-workspaces/lp-should-not-exist
expect_fail "write neighbour workspace" touch "${LP_NEIGHBOUR_DIR}/lp-should-not-exist"

banner "WRITE INSIDE WORKSPACE (must succeed — proves the probe is not simply broken)"
if touch ./lp-write-probe && printf 'ok\n' >./lp-write-probe; then
  printf 'OK wrote %s/lp-write-probe\n' "$(pwd)"
  rm -f ./lp-write-probe
else
  printf 'FAIL(unusable) could not write inside own workspace\n'
fi

banner "PRIVATE TMP"
printf '/tmp contents: [%s]\n' "$(ls -A /tmp 2>&1 | tr '\n' ' ')"

banner "PROCESS VISIBILITY (ProtectProc=invisible)"
printf 'pids visible in /proc: %s\n' "$(find /proc -maxdepth 1 -regex '/proc/[0-9]+' 2>/dev/null | wc -l)"
printf 'can read PID 1 cmdline? '
if cat /proc/1/cmdline >/dev/null 2>&1; then printf 'YES (unexpected)\n'; else printf 'no\n'; fi

banner "APPLIED CGROUP LIMITS"
# The limits live on this service's own cgroup, not the tree root, so the path
# has to come from /proc/self/cgroup rather than being assumed.
own_cgroup="/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup | head -1)"
printf 'cgroup:     %s\n' "${own_cgroup}"
printf 'memory.max: %s\n' "$(cat "${own_cgroup}/memory.max" 2>/dev/null || echo unreadable)"
printf 'memory.high:%s\n' "$(cat "${own_cgroup}/memory.high" 2>/dev/null || echo unreadable)"
printf 'pids.max:   %s\n' "$(cat "${own_cgroup}/pids.max" 2>/dev/null || echo unreadable)"
expect_fail "raise own memory.max" tee "${own_cgroup}/memory.max"

printf '\nLP-CHECKS-COMPLETE\n'

# Idle so the unit remains a genuine long-lived service under inspection.
exec sleep 3600
PROBE_EOF

chown "${probe_user}:${probe_user}" "${probe_dir}/run" "${probe_dir}/env"
chmod 0700 "${probe_dir}/run"
chmod 0600 "${probe_dir}/env"

lp_log "starting ${unit_name}"
systemctl restart "${unit_name}"

lp_log "waiting for probe to finish reporting"
for _ in $(seq 1 30); do
  if journalctl -u "${unit_name}" --since "-2 min" --no-pager 2>/dev/null | grep -q 'LP-CHECKS-COMPLETE'; then
    break
  fi
  sleep 1
done

printf '\n########## SERVICE STATE ##########\n'
systemctl is-active "${unit_name}" || true
systemctl show "${unit_name}" \
  -p MainPID -p User -p MemoryMax -p TasksMax -p NoNewPrivileges \
  -p ProtectSystem -p ProtectHome -p ProtectKernelTunables \
  -p ProtectControlGroups -p RestrictSUIDSGID -p PrivateTmp -p ReadWritePaths

printf '\n########## PROBE EVIDENCE ##########\n'
journalctl -u "${unit_name}" --since "-5 min" --no-pager --output cat
