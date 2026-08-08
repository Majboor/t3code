#!/usr/bin/env bash
# Provision one isolated workspace: a dedicated unprivileged Linux user, a
# directory that only that user can enter, and the hardened systemd unit
# template that will run its service.
#
# Idempotent: re-running against an existing workspace re-asserts ownership and
# permissions and rewrites the limits drop-in, but never destroys workspace
# content and never recreates the account (which would change its uid).
#
# Usage:
#   lp-provision-workspace.sh <workspace-id> [--memory-max 512M] [--tasks-max 64]
#
# Deliberately NOT done here: starting the service. Provisioning creates the
# container for a workload; deciding when a workload runs belongs to the
# deploy step that sits on top of this.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lp-common.sh
source "${script_dir}/lp-common.sh"

workspace_id=""
memory_max="${LP_DEFAULT_MEMORY_MAX}"
tasks_max="${LP_DEFAULT_TASKS_MAX}"

usage() {
  cat <<'EOF'
Usage: lp-provision-workspace.sh <workspace-id> [options]

Options:
  --memory-max <value>   Hard memory cap for the workspace service (default 512M)
  --tasks-max <count>    Maximum processes/threads for the workspace (default 64)
  -h, --help             Show this help

Creates:
  user       lp-<workspace-id>   (system account, nologin shell, no password)
  directory  /srv/lp-workspaces/lp-<workspace-id>   (mode 0700, owned by that user)
  unit       lp-workspace@.service + lp-workspace@<workspace-id>.service.d/10-limits.conf
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --memory-max)
      [[ $# -ge 2 ]] || lp_die "--memory-max requires a value"
      memory_max="$2"; shift 2 ;;
    --tasks-max)
      [[ $# -ge 2 ]] || lp_die "--tasks-max requires a value"
      tasks_max="$2"; shift 2 ;;
    -*) lp_die "unknown option '$1' (try --help)" ;;
    *)
      [[ -z "${workspace_id}" ]] || lp_die "unexpected extra argument '$1'"
      workspace_id="$1"; shift ;;
  esac
done

lp_require_root
lp_validate_workspace_id "${workspace_id}"

[[ "${tasks_max}" =~ ^[0-9]+$ ]] || lp_die "--tasks-max must be a positive integer, got '${tasks_max}'"
[[ "${memory_max}" =~ ^[0-9]+[KMG]?$ ]] || lp_die "--memory-max must look like 512M or 1G, got '${memory_max}'"

user_name="$(lp_user_for "${workspace_id}")"
workspace_dir="$(lp_dir_for "${workspace_id}")"
dropin_dir="$(lp_dropin_dir_for "${workspace_id}")"

lp_assert_owned_user "${user_name}"
lp_check_disk 64

# --- shared parent -------------------------------------------------------
# Root-owned and world-traversable so each workspace can reach its own
# directory, but not writable by any workspace: a workspace must not be able to
# create or rename entries beside its neighbours.
if [[ ! -d "${LP_ROOT}" ]]; then
  lp_log "creating workspace root ${LP_ROOT}"
  mkdir -p "${LP_ROOT}"
fi
chown root:root "${LP_ROOT}"
chmod 0755 "${LP_ROOT}"

# --- account -------------------------------------------------------------
if id -u "${user_name}" >/dev/null 2>&1; then
  lp_log "user ${user_name} already exists; leaving its uid untouched"
else
  lp_log "creating system user ${user_name}"
  # --system keeps the account out of the human uid range so it is never
  # mistaken for an operator login. nologin plus no password means the account
  # cannot be used to reach the host over SSH or su.
  useradd \
    --system \
    --home-dir "${workspace_dir}" \
    --no-create-home \
    --shell /usr/sbin/nologin \
    --comment "T3 isolated workspace ${workspace_id}" \
    "${user_name}" \
    || lp_die "useradd failed for ${user_name}"
fi

# Explicitly lock the password field even though useradd leaves it unset, so
# the guarantee survives any later tooling that sets one.
passwd --lock "${user_name}" >/dev/null 2>&1 || lp_warn "could not lock password for ${user_name}"

# --- workspace directory -------------------------------------------------
lp_log "ensuring workspace directory ${workspace_dir}"
mkdir -p "${workspace_dir}"
chown "${user_name}:${user_name}" "${workspace_dir}"
# 0700 is what makes one workspace unreadable to another at the DAC layer; the
# systemd sandbox is a second, independent layer on top of it.
chmod 0700 "${workspace_dir}"

# --- unit template -------------------------------------------------------
template_src="${script_dir}/${LP_UNIT_TEMPLATE}"
template_dst="${LP_UNIT_DIR}/${LP_UNIT_TEMPLATE}"
[[ -f "${template_src}" ]] || lp_die "unit template not found beside this script: ${template_src}"

if ! cmp -s "${template_src}" "${template_dst}"; then
  lp_log "installing unit template ${template_dst}"
  install -m 0644 -o root -g root "${template_src}" "${template_dst}"
else
  lp_log "unit template already current"
fi

# --- per-workspace limits ------------------------------------------------
# MemoryHigh is recomputed rather than inherited: leaving the template's value
# in place while lowering MemoryMax would put the throttle above the kill line,
# so the workspace would be OOM-killed with no back-pressure phase first.
memory_max_bytes="$(lp_size_to_bytes "${memory_max}")" || lp_die "could not parse --memory-max '${memory_max}'"
memory_high_bytes="$((memory_max_bytes * 3 / 4))"

lp_log "writing limits drop-in (MemoryMax=${memory_max} MemoryHigh=${memory_high_bytes} TasksMax=${tasks_max})"
mkdir -p "${dropin_dir}"
cat >"${dropin_dir}/10-limits.conf" <<EOF
# Generated by lp-provision-workspace.sh for workspace ${workspace_id}.
# Overrides the floor limits baked into lp-workspace@.service.
[Service]
MemoryHigh=${memory_high_bytes}
MemoryMax=${memory_max}
TasksMax=${tasks_max}
EOF
chmod 0644 "${dropin_dir}/10-limits.conf"

systemctl daemon-reload

lp_log "provisioned workspace '${workspace_id}'"
lp_log "  user      ${user_name} (uid $(id -u "${user_name}"))"
lp_log "  directory ${workspace_dir}"
lp_log "  unit      $(lp_unit_for "${workspace_id}")"
lp_log "next: install an executable 'run' at ${workspace_dir}/run, then 'systemctl start $(lp_unit_for "${workspace_id}")'"
