#!/usr/bin/env bash
# Shared definitions for the lp-* workspace isolation scripts.
#
# Sourced, never executed directly. Every path, name and prefix that the
# tooling is allowed to create is declared here so that teardown can be proven
# to remove exactly the same set — a teardown that recomputes names
# independently of provisioning is a teardown that eventually drifts.

set -euo pipefail

# Sourced twice by anything that pulls in two libraries which both need it, and
# every constant below is readonly — so without this guard the second source
# fails the whole script rather than being the no-op the caller expects.
[[ -n "${LP_COMMON_SOURCED-}" ]] && return 0
LP_COMMON_SOURCED=1

# Single source of truth for the namespace. Everything the tooling creates on a
# shared host carries this prefix so an operator who knows nothing about this
# project can still identify and remove it.
readonly LP_PREFIX="lp-"

# Workspaces deliberately live outside /home: the hardened unit sets
# ProtectHome=yes, which would make a home-directory workspace unreachable by
# the very service that owns it.
readonly LP_ROOT="/srv/lp-workspaces"

readonly LP_UNIT_TEMPLATE="lp-workspace@.service"
readonly LP_UNIT_DIR="/etc/systemd/system"

# Conservative defaults sized for a host that is already memory- and
# disk-constrained. A workspace that needs more must say so explicitly rather
# than silently inheriting room to starve its neighbours.
readonly LP_DEFAULT_MEMORY_MAX="512M"
readonly LP_DEFAULT_TASKS_MAX="64"

# Converts a systemd-style size (512M, 1G, 1048576) to plain bytes so callers
# can do arithmetic on it. Needed because MemoryHigh must be derived from
# MemoryMax: if a workspace lowers its cap below the template's MemoryHigh, the
# throttle threshold would sit above the kill threshold and never fire.
lp_size_to_bytes() {
  local value="$1" number suffix

  number="${value%[KMG]}"
  suffix="${value#"${number}"}"

  case "${suffix}" in
    K) printf '%s' "$((number * 1024))" ;;
    M) printf '%s' "$((number * 1024 * 1024))" ;;
    G) printf '%s' "$((number * 1024 * 1024 * 1024))" ;;
    "") printf '%s' "${number}" ;;
    *) return 1 ;;
  esac
}

lp_log() { printf '[lp] %s\n' "$*" >&2; }
lp_warn() { printf '[lp] WARNING: %s\n' "$*" >&2; }
lp_die() { printf '[lp] ERROR: %s\n' "$*" >&2; exit 1; }

lp_require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    lp_die "must run as root (creating users and systemd units requires it); got uid ${EUID}"
  fi
}

# Rejects anything that could escape a path, collide with a real account, or
# overflow the 32-character limit that useradd enforces on the final name.
# Validation lives here rather than in each script so provisioning and teardown
# can never disagree about what a legal id is.
lp_validate_workspace_id() {
  local id="${1-}"

  [[ -n "${id}" ]] || lp_die "workspace id is required"

  if [[ ! "${id}" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    lp_die "invalid workspace id '${id}': use lowercase letters, digits and hyphens, starting with a letter or digit"
  fi

  if [[ "${id}" == *--* ]]; then
    lp_die "invalid workspace id '${id}': consecutive hyphens are not allowed"
  fi

  local user_name="${LP_PREFIX}${id}"
  if [[ "${#user_name}" -gt 32 ]]; then
    lp_die "workspace id '${id}' is too long: derived user '${user_name}' exceeds the 32-character limit"
  fi
}

lp_user_for() { printf '%s%s' "${LP_PREFIX}" "$1"; }
lp_dir_for() { printf '%s/%s%s' "${LP_ROOT}" "${LP_PREFIX}" "$1"; }
lp_unit_for() { printf 'lp-workspace@%s.service' "$1"; }
lp_dropin_dir_for() { printf '%s/lp-workspace@%s.service.d' "${LP_UNIT_DIR}" "$1"; }

# Refuses to act on an account the tooling did not create. Without this a typo
# in an id could hand userdel a system account on a host running ~85 services.
lp_assert_owned_user() {
  local user_name="$1"

  if [[ "${user_name}" != "${LP_PREFIX}"* ]]; then
    lp_die "refusing to touch user '${user_name}': not in the ${LP_PREFIX} namespace"
  fi
}

# Guards the disk before any step that writes. The target host runs at ~95%
# full, so "there is probably room" is not a safe assumption to make silently.
lp_check_disk() {
  local required_mb="${1:-64}"
  local available_mb

  available_mb="$(df -Pm / | awk 'NR==2 {print $4}')"

  if [[ -z "${available_mb}" ]]; then
    lp_warn "could not determine free space on /; continuing without a disk guard"
    return 0
  fi

  lp_log "free space on /: ${available_mb}MB (need ${required_mb}MB)"

  if [[ "${available_mb}" -lt "${required_mb}" ]]; then
    lp_die "insufficient free space on /: ${available_mb}MB available, ${required_mb}MB required"
  fi
}
