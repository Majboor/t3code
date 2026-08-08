#!/usr/bin/env bash
# Remove exactly what lp-provision-workspace.sh created for one workspace.
#
# Idempotent: every step tolerates the thing already being absent, so a partial
# provision can always be cleaned up by running this once.
#
# Usage:
#   lp-teardown-workspace.sh <workspace-id> [--keep-data] [--remove-template]
#
# The workspace directory is removed by default. --keep-data exists for the
# case where an operator wants the account and unit gone but needs to salvage
# the contents first.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lp-common.sh
source "${script_dir}/lp-common.sh"

workspace_id=""
keep_data="no"
remove_template="no"

usage() {
  cat <<'EOF'
Usage: lp-teardown-workspace.sh <workspace-id> [options]

Options:
  --keep-data         Leave /srv/lp-workspaces/lp-<id> in place (still removes user and unit)
  --remove-template   Also remove the shared lp-workspace@.service template and the
                      empty /srv/lp-workspaces parent, if no lp- workspaces remain
  -h, --help          Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --keep-data) keep_data="yes"; shift ;;
    --remove-template) remove_template="yes"; shift ;;
    -*) lp_die "unknown option '$1' (try --help)" ;;
    *)
      [[ -z "${workspace_id}" ]] || lp_die "unexpected extra argument '$1'"
      workspace_id="$1"; shift ;;
  esac
done

lp_require_root
lp_validate_workspace_id "${workspace_id}"

user_name="$(lp_user_for "${workspace_id}")"
workspace_dir="$(lp_dir_for "${workspace_id}")"
dropin_dir="$(lp_dropin_dir_for "${workspace_id}")"
unit_name="$(lp_unit_for "${workspace_id}")"

# Both guards matter: the first keeps userdel away from anything outside the
# namespace, the second keeps rm -rf away from any path this tooling did not
# compute. Neither is theoretical on a host running ~85 unrelated services.
lp_assert_owned_user "${user_name}"
case "${workspace_dir}" in
  "${LP_ROOT}/${LP_PREFIX}"?*) : ;;
  *) lp_die "refusing to remove '${workspace_dir}': not inside ${LP_ROOT}/${LP_PREFIX}*" ;;
esac

# --- service -------------------------------------------------------------
if systemctl list-unit-files "${unit_name}" >/dev/null 2>&1 || systemctl is-active --quiet "${unit_name}"; then
  if systemctl is-active --quiet "${unit_name}"; then
    lp_log "stopping ${unit_name}"
    systemctl stop "${unit_name}" || lp_warn "could not stop ${unit_name}"
  fi
  if systemctl is-enabled --quiet "${unit_name}" 2>/dev/null; then
    lp_log "disabling ${unit_name}"
    systemctl disable "${unit_name}" >/dev/null 2>&1 || lp_warn "could not disable ${unit_name}"
  fi
fi
# Clears any failed state so a torn-down instance stops showing up in
# systemctl --failed.
systemctl reset-failed "${unit_name}" >/dev/null 2>&1 || true

if [[ -d "${dropin_dir}" ]]; then
  lp_log "removing drop-in directory ${dropin_dir}"
  rm -rf -- "${dropin_dir}"
fi

# --- account -------------------------------------------------------------
# Kill anything still owned by the account before userdel, otherwise a lingering
# process would keep running under a uid that is about to be recycled.
if id -u "${user_name}" >/dev/null 2>&1; then
  if pgrep -u "${user_name}" >/dev/null 2>&1; then
    lp_log "terminating remaining processes owned by ${user_name}"
    pkill -TERM -u "${user_name}" || true
    for _ in 1 2 3 4 5; do
      pgrep -u "${user_name}" >/dev/null 2>&1 || break
      sleep 1
    done
    pkill -KILL -u "${user_name}" 2>/dev/null || true
  fi

  lp_log "removing user ${user_name}"
  # --force is required because the account's home is the workspace directory,
  # which userdel would otherwise refuse to detach from.
  userdel --force "${user_name}" >/dev/null 2>&1 || lp_warn "userdel reported an issue for ${user_name}"
else
  lp_log "user ${user_name} already absent"
fi

# A stale group can outlive the user when the group is not the user's primary.
if getent group "${user_name}" >/dev/null 2>&1; then
  lp_log "removing group ${user_name}"
  groupdel "${user_name}" >/dev/null 2>&1 || lp_warn "could not remove group ${user_name}"
fi

# --- data ----------------------------------------------------------------
if [[ "${keep_data}" == "yes" ]]; then
  lp_log "keeping workspace directory ${workspace_dir} as requested"
elif [[ -d "${workspace_dir}" ]]; then
  lp_log "removing workspace directory ${workspace_dir}"
  rm -rf -- "${workspace_dir}"
else
  lp_log "workspace directory ${workspace_dir} already absent"
fi

# --- shared assets -------------------------------------------------------
if [[ "${remove_template}" == "yes" ]]; then
  remaining="$(find "${LP_ROOT}" -maxdepth 1 -mindepth 1 -name "${LP_PREFIX}*" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "${remaining}" == "0" ]]; then
    lp_log "removing shared unit template ${LP_UNIT_DIR}/${LP_UNIT_TEMPLATE}"
    rm -f -- "${LP_UNIT_DIR}/${LP_UNIT_TEMPLATE}"
    rmdir "${LP_ROOT}" 2>/dev/null || lp_warn "${LP_ROOT} not empty; left in place"
  else
    lp_warn "${remaining} workspace(s) still present; keeping shared template and ${LP_ROOT}"
  fi
fi

systemctl daemon-reload

lp_log "teardown complete for workspace '${workspace_id}'"
