#!/usr/bin/env bash
# Shared definitions for the lp-deploy tooling.
#
# Sourced, never executed directly. Sits on top of infra/host/lp-common.sh and
# adds the two resources a deployment needs that a bare workspace does not: a
# loopback address it can be reached on, and a TCP port behind it.
#
# There is deliberately no separate allocation database. The per-workspace
# systemd drop-in this tooling writes *is* the record of what was allocated, so
# an operator reading /etc/systemd/system sees the same truth the scripts do and
# a stale registry file cannot disagree with a running service.

set -euo pipefail

lp_deploy_common_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../host/lp-common.sh
source "${lp_deploy_common_dir}/../host/lp-common.sh"

readonly LP_HOST_DIR="${lp_deploy_common_dir}/../host"

# Each deployment gets its own address inside 127.90.0.0/16 rather than sharing
# 127.0.0.1. That is what makes a single-/32 firewall rule possible: the address
# is the workspace's identity on the loopback interface, so "allow the workspace
# to talk to itself" and "allow the workspace to talk to every other service on
# this host" stop being the same rule.
readonly LP_ADDR_PREFIX="127.90"
readonly LP_ADDR_MAX_BLOCK=3

# A range with nothing else on it, checked against `ss -ltn` at allocation time
# anyway. Kept high so it cannot collide with the host's dense 5000-9000 range.
readonly LP_PORT_MIN=21000
readonly LP_PORT_MAX=21999

# Refuse to copy an application larger than this. The host is shared and the
# guard exists so a mistaken --from pointing at a node_modules-laden source tree
# fails immediately instead of halfway through filling the disk.
readonly LP_DEPLOY_MAX_SIZE_MB_DEFAULT=2048

readonly LP_DEPLOY_DROPIN_NAME="20-network.conf"

lp_deploy_dropin_for() {
  printf '%s/lp-workspace@%s.service.d/%s' "${LP_UNIT_DIR}" "$1" "${LP_DEPLOY_DROPIN_NAME}"
}

lp_deploy_app_dir_for() { printf '%s/app' "$(lp_dir_for "$1")"; }

# Reads one of the "# lp-key=value" header lines the drop-in carries. These
# comments are the allocation record; systemd ignores them, which is precisely
# why they are safe to put there.
lp_deploy_dropin_field() {
  local file="$1" key="$2" prefix line

  [[ -f "${file}" ]] || return 1
  prefix="# ${key}="
  line="$(grep -m1 -- "^${prefix}" "${file}" 2>/dev/null || true)"
  [[ -n "${line}" ]] || return 1
  printf '%s' "${line#"${prefix}"}"
}

# Every address and port this tooling has already handed out, read back from the
# drop-ins. Includes the workspace being deployed, so callers filter it out.
lp_deploy_allocated() {
  local key="$1" file value

  for file in "${LP_UNIT_DIR}"/lp-workspace@*.service.d/"${LP_DEPLOY_DROPIN_NAME}"; do
    [[ -f "${file}" ]] || continue
    value="$(lp_deploy_dropin_field "${file}" "${key}" || true)"
    [[ -n "${value}" ]] && printf '%s\n' "${value}"
  done
}

lp_deploy_allocate_address() {
  local self_address="${1-}"
  local taken block host_part candidate

  # A redeploy keeps the address it already holds, so the URL an operator or a
  # proxy config recorded stays valid across deployments.
  if [[ -n "${self_address}" ]]; then
    printf '%s' "${self_address}"
    return 0
  fi

  taken="$(lp_deploy_allocated lp-address || true)"

  for ((block = 0; block <= LP_ADDR_MAX_BLOCK; block++)); do
    for ((host_part = 1; host_part <= 254; host_part++)); do
      candidate="${LP_ADDR_PREFIX}.${block}.${host_part}"
      grep -qxF "${candidate}" <<<"${taken}" && continue
      # An address already on the interface but not in any drop-in belongs to
      # something this tooling did not create; skipping it is cheaper than
      # arguing about who owns it.
      ip -4 -o addr show dev lo 2>/dev/null | grep -qw "${candidate}/32" && continue
      printf '%s' "${candidate}"
      return 0
    done
  done

  lp_die "no free address left in ${LP_ADDR_PREFIX}.0.0/${LP_ADDR_MAX_BLOCK}; tear down unused deployments first"
}

lp_deploy_port_in_use() {
  local port="$1"
  [[ -n "$(ss -ltnH "sport = :${port}" 2>/dev/null)" ]]
}

lp_deploy_allocate_port() {
  local self_port="${1-}"
  local taken candidate

  taken="$(lp_deploy_allocated lp-port || true)"

  if [[ -n "${self_port}" ]]; then
    printf '%s' "${self_port}"
    return 0
  fi

  for ((candidate = LP_PORT_MIN; candidate <= LP_PORT_MAX; candidate++)); do
    grep -qxF "${candidate}" <<<"${taken}" && continue
    lp_deploy_port_in_use "${candidate}" && continue
    printf '%s' "${candidate}"
    return 0
  done

  lp_die "no free port left in ${LP_PORT_MIN}-${LP_PORT_MAX}"
}

# --- allow-list arithmetic -------------------------------------------------
#
# systemd's IP filter is NOT longest-prefix-wins across the two lists. An
# address matching any IPAddressAllow= entry is permitted outright, whatever
# IPAddressDeny= says; the deny list only decides addresses the allow list did
# not match. Verified on the target host: a unit with
#
#   IPAddressDeny=any  IPAddressAllow=0.0.0.0/1  IPAddressDeny=127.0.0.0/8
#
# reached 127.0.0.1:3900 without obstruction. "Allow everything except X" is
# therefore not expressible by adding a deny for X — X has to be *absent* from
# the allow list, which means the allowed space must be enumerated.
#
# So these helpers compute the complement: the whole IPv4 space minus every
# range that would put the workspace back on this host or its private networks.

readonly LP_IPV4_MAX=4294967295

# Ranges a deployment must never be able to address. Loopback is the headline —
# it is where this host keeps unauthenticated object storage, a media server and
# several app servers — but the private and link-local ranges matter just as
# much: 169.254.169.254 is the cloud metadata address, and the docker bridges
# are ordinary RFC1918.
readonly -a LP_EXCLUDED_RANGES=(
  0.0.0.0/8
  10.0.0.0/8
  100.64.0.0/10
  127.0.0.0/8
  169.254.0.0/16
  172.16.0.0/12
  192.0.0.0/24
  192.168.0.0/16
  198.18.0.0/15
  224.0.0.0/4
  240.0.0.0/4
)

lp_ip_to_int() {
  local IFS=. a b c d
  read -r a b c d <<<"$1"
  printf '%s' "$(( (a << 24) + (b << 16) + (c << 8) + d ))"
}

lp_int_to_ip() {
  local n="$1"
  printf '%s.%s.%s.%s' "$(( (n >> 24) & 255 ))" "$(( (n >> 16) & 255 ))" "$(( (n >> 8) & 255 ))" "$(( n & 255 ))"
}

lp_cidr_range() {
  local cidr="$1" bits base size
  bits="${cidr#*/}"
  base="$(lp_ip_to_int "${cidr%/*}")"
  size="$(( 1 << (32 - bits) ))"
  # Two's complement rounds the base down to the block boundary, so a sloppily
  # written prefix like 10.1.2.3/8 still yields the range 10.0.0.0-10.255.255.255.
  base="$(( base & -size ))"
  # Trailing newline matters: callers read this with `read`, which reports
  # failure on an unterminated line and would trip `set -e`.
  printf '%s %s\n' "${base}" "$(( base + size - 1 ))"
}

# Emits the fewest CIDR blocks that exactly cover [start, end]. Greedy: at each
# step take the largest power-of-two block that both aligns with the current
# offset and still fits inside the range.
lp_range_to_cidrs() {
  local start="$1" end="$2" exp size

  while (( start <= end )); do
    exp=0
    while (( exp < 32 )); do
      size="$(( 1 << (exp + 1) ))"
      (( start % size == 0 )) || break
      (( start + size - 1 <= end )) || break
      exp="$(( exp + 1 ))"
    done
    printf '%s/%s\n' "$(lp_int_to_ip "${start}")" "$(( 32 - exp ))"
    start="$(( start + (1 << exp) ))"
  done
}

# The IPv4 space a deployment may reach: everything public, with this host's own
# addresses punched out.
#
# The host's addresses matter as much as loopback. Anything bound to 0.0.0.0
# here — t3code on 3773, a dozen uvicorn and gunicorn apps — answers on the
# host's public address too, so blocking loopback while allowing the public
# internet would leave the same services exactly one hop away.
lp_deploy_public_allow_prefixes() {
  local cidr start end cursor
  local -a ranges=()

  for cidr in "${LP_EXCLUDED_RANGES[@]}"; do
    read -r start end < <(lp_cidr_range "${cidr}")
    ranges+=("${start} ${end}")
  done

  while read -r cidr; do
    [[ -n "${cidr}" ]] || continue
    read -r start end < <(lp_cidr_range "${cidr}")
    ranges+=("${start} ${end}")
  done < <(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1] "/32"}')

  cursor=0
  while read -r start end; do
    (( start > cursor )) && lp_range_to_cidrs "${cursor}" "$(( start - 1 ))"
    (( end >= cursor )) && cursor="$(( end + 1 ))"
  done < <(printf '%s\n' "${ranges[@]}" | sort -n -k1,1 -k2,2)

  (( cursor <= LP_IPV4_MAX )) && lp_range_to_cidrs "${cursor}" "${LP_IPV4_MAX}"
  return 0
}

lp_deploy_ensure_loopback_alias() {
  local address="$1"

  if ip -4 -o addr show dev lo 2>/dev/null | grep -qw "${address}/32"; then
    return 0
  fi

  lp_log "adding loopback alias ${address}/32"
  # The /32 is load-bearing beyond mere addressing. Without it the kernel routes
  # 127.90.x.y through the generic 127.0.0.0/8 local route, whose preferred
  # source is 127.0.0.1 — so an inbound connection would arrive *from* 127.0.0.1
  # and the ingress filter would have to allow all of loopback to accept it.
  # With the alias present the route's source becomes the alias itself, and one
  # /32 covers both directions.
  ip addr add "${address}/32" dev lo || lp_die "could not add loopback alias ${address}/32"
}

lp_deploy_remove_loopback_alias() {
  local address="$1"

  case "${address}" in
    "${LP_ADDR_PREFIX}".*) : ;;
    *) lp_die "refusing to remove '${address}': outside the ${LP_ADDR_PREFIX}.0.0/16 deploy range" ;;
  esac

  if ip -4 -o addr show dev lo 2>/dev/null | grep -qw "${address}/32"; then
    lp_log "removing loopback alias ${address}/32"
    ip addr del "${address}/32" dev lo || lp_warn "could not remove loopback alias ${address}/32"
  else
    lp_log "loopback alias ${address}/32 already absent"
  fi
}

lp_deploy_url_for() { printf 'http://%s:%s' "$1" "$2"; }

# Waits for the deployed service to answer. Polling rather than a single check
# because "started" and "listening" are different moments for every runtime.
lp_deploy_wait_healthy() {
  local url="$1" attempts="${2:-30}" attempt

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl -fsS -o /dev/null --max-time 3 "${url}" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done

  return 1
}
