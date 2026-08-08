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

[[ -n "${LP_DEPLOY_COMMON_SOURCED-}" ]] && return 0
LP_DEPLOY_COMMON_SOURCED=1

lp_deploy_common_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../host/lp-common.sh
source "${lp_deploy_common_dir}/../host/lp-common.sh"
# shellcheck source=./lp-telemetry.sh
source "${lp_deploy_common_dir}/lp-telemetry.sh"

readonly LP_HOST_DIR="${lp_deploy_common_dir}/../host"
readonly LP_DEPLOY_DIR="${lp_deploy_common_dir}"

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

# The kernel logs an IPv6 destination fully expanded and a resolver returns it
# compressed, so the two spellings of one address do not compare equal. Without
# this, a denied destination the manifest actually declared is reported as
# undeclared — which inverts the meaning of the event.
lp_ipv6_expand() {
  local addr head tail group fill i out=""
  local -a head_groups=() tail_groups=() parts=()

  addr="$(tr '[:upper:]' '[:lower:]' <<<"$1")"

  [[ "${addr}" == *:* ]] || { printf '%s' "${addr}"; return 0; }

  if [[ "${addr}" == *"::"* ]]; then
    head="${addr%%::*}"
    tail="${addr##*::}"
  else
    head="${addr}"
    tail=""
  fi

  IFS=':' read -r -a parts <<<"${head}"
  for group in "${parts[@]}"; do [[ -n "${group}" ]] && head_groups+=("${group}"); done
  IFS=':' read -r -a parts <<<"${tail}"
  for group in "${parts[@]}"; do [[ -n "${group}" ]] && tail_groups+=("${group}"); done

  fill="$(( 8 - ${#head_groups[@]} - ${#tail_groups[@]} ))"
  (( fill < 0 )) && { printf '%s' "${addr}"; return 0; }

  for group in ${head_groups[@]+"${head_groups[@]}"}; do out+="$(printf '%04x' "0x${group}"):"; done
  for ((i = 0; i < fill; i++)); do out+="0000:"; done
  for group in ${tail_groups[@]+"${tail_groups[@]}"}; do out+="$(printf '%04x' "0x${group}"):"; done

  printf '%s' "${out%:}"
}

# --- observing what the filter dropped ------------------------------------
#
# The cgroup BPF filter discards a denied packet without a trace: no EPERM, no
# log line, nothing in `systemctl show` beyond a byte counter that does not name
# a destination. docs/deployment.md records `egress.denied` as unavailable for
# exactly that reason and names the two possible fixes; this is the second one,
# a netfilter log rule.
#
# It works because the two hooks run in a fixed order. NF_INET_LOCAL_OUT fires
# in __ip_local_out, and the cgroup egress program runs later, in ip_output. So
# a rule here sees the SYN that the filter is about to drop, and can report the
# destination the filter cannot.
#
# The chain's policy is accept and it contains no verdict beyond `return`: it
# observes, it never decides. Enforcement stays in one place.
readonly LP_NFT_FAMILY="inet"
readonly LP_NFT_LOG_PREFIX="lp-egress-deny"

# nftables identifiers take no hyphens, and a workspace id may.
lp_nft_table_for() { printf 'lp_egress_%s' "${1//-/_}"; }

lp_nft_available() { command -v nft >/dev/null 2>&1; }

# Takes the allow list on stdin: exactly the prefixes written into the unit's
# IPAddressAllow=, so the set that decides what is logged as denied is literally
# the set that decides what is permitted, and the two cannot drift.
lp_nft_install() {
  local id="$1" uid="$2"
  local table prefixes v4 v6 sets="" rules=""

  if ! lp_nft_available; then
    lp_warn "nft is not installed; egress.denied cannot be observed on this host (the BPF filter drops silently)"
    return 1
  fi

  table="$(lp_nft_table_for "${id}")"
  prefixes="$(cat)"
  v4="$(grep -v ':' <<<"${prefixes}" | sed '/^$/d' | paste -sd, - | sed 's/,/, /g')"
  v6="$(grep ':' <<<"${prefixes}" | sed '/^$/d' | paste -sd, - | sed 's/,/, /g')"

  # A family with nothing allowed gets no set and no return rule, so every
  # packet in it falls through to the log rule — which is correct, because the
  # unit allows nothing in that family either.
  if [[ -n "${v4}" ]]; then
    sets+="  set allowed4 { type ipv4_addr; flags interval; elements = { ${v4} } }"$'\n'
    rules+="    meta skuid ${uid} ip daddr @allowed4 return"$'\n'
  fi
  if [[ -n "${v6}" ]]; then
    sets+="  set allowed6 { type ipv6_addr; flags interval; elements = { ${v6} } }"$'\n'
    rules+="    meta skuid ${uid} ip6 daddr @allowed6 return"$'\n'
  fi

  nft delete table "${LP_NFT_FAMILY}" "${table}" 2>/dev/null || true

  # `limit rate` bounds journal cost: a pack in a tight reconnect loop must not
  # become a logging denial of service against a host with 84 other services.
  # Only connection openings are logged, which is what a "denied destination"
  # actually is.
  nft -f - <<EOF || { lp_warn "could not install the egress observation table ${table}"; return 1; }
table ${LP_NFT_FAMILY} ${table} {
${sets}
  chain observe {
    type filter hook output priority filter; policy accept;
${rules}    meta skuid ${uid} tcp flags & (fin|syn|rst|ack) == syn limit rate 10/second burst 5 packets log prefix "${LP_NFT_LOG_PREFIX} ${id}: " level info
  }
}
EOF

  return 0
}

lp_nft_remove() {
  local id="$1" table
  table="$(lp_nft_table_for "${id}")"

  lp_nft_available || return 0

  if nft list table "${LP_NFT_FAMILY}" "${table}" >/dev/null 2>&1; then
    lp_log "removing egress observation table ${LP_NFT_FAMILY} ${table}"
    nft delete table "${LP_NFT_FAMILY}" "${table}" || lp_warn "could not delete nft table ${table}"
  fi
}

# --- the telemetry timer ---------------------------------------------------
#
# A separate unit rather than a loop inside the deployment: the events that
# matter most are the ones a dead deployment cannot send, so the emitter has to
# outlive the thing it observes.
readonly LP_HEARTBEAT_TEMPLATE_SERVICE="lp-heartbeat@.service"
readonly LP_HEARTBEAT_TEMPLATE_TIMER="lp-heartbeat@.timer"

lp_heartbeat_unit_for() { printf 'lp-heartbeat@%s.service' "$1"; }
lp_heartbeat_timer_for() { printf 'lp-heartbeat@%s.timer' "$1"; }
lp_heartbeat_dropin_dir_for() { printf '%s/lp-heartbeat@%s.timer.d' "${LP_UNIT_DIR}" "$1"; }

# The templates are installed rather than copied verbatim: ExecStart has to name
# the absolute path of the checkout this runner was invoked from, and that is
# host-specific.
lp_heartbeat_install_templates() {
  local src dst

  for src in "${LP_HEARTBEAT_TEMPLATE_SERVICE}" "${LP_HEARTBEAT_TEMPLATE_TIMER}"; do
    [[ -f "${LP_DEPLOY_DIR}/${src}" ]] || lp_die "unit template not found beside the runner: ${LP_DEPLOY_DIR}/${src}"
    dst="${LP_UNIT_DIR}/${src}"
    sed "s|@LP_DEPLOY_DIR@|${LP_DEPLOY_DIR}|g" "${LP_DEPLOY_DIR}/${src}" >"${dst}.tmp"
    if ! cmp -s "${dst}.tmp" "${dst}"; then
      mv -- "${dst}.tmp" "${dst}"
      chmod 0644 "${dst}"
    else
      rm -f -- "${dst}.tmp"
    fi
  done
}

lp_heartbeat_enable() {
  local id="$1" interval="$2" dropin_dir

  lp_heartbeat_install_templates

  dropin_dir="$(lp_heartbeat_dropin_dir_for "${id}")"
  mkdir -p "${dropin_dir}"
  cat >"${dropin_dir}/10-interval.conf" <<EOF
# Generated by lp-deploy.sh for workspace ${id}. The synthesiser reads the same
# interval out of the deployment's telemetry state, so 'three missed intervals'
# means the same number of seconds in both places.
[Timer]
OnActiveSec=${interval}s
OnUnitActiveSec=${interval}s
EOF
  chmod 0644 "${dropin_dir}/10-interval.conf"

  systemctl daemon-reload
  systemctl enable --now "$(lp_heartbeat_timer_for "${id}")" >/dev/null 2>&1 \
    || lp_warn "could not enable $(lp_heartbeat_timer_for "${id}"); heartbeats will not be emitted"
}

lp_heartbeat_disable() {
  local id="$1" timer dropin_dir
  timer="$(lp_heartbeat_timer_for "${id}")"
  dropin_dir="$(lp_heartbeat_dropin_dir_for "${id}")"

  if systemctl is-active --quiet "${timer}" 2>/dev/null; then
    systemctl stop "${timer}" || lp_warn "could not stop ${timer}"
  fi
  systemctl disable "${timer}" >/dev/null 2>&1 || true
  systemctl reset-failed "$(lp_heartbeat_unit_for "${id}")" >/dev/null 2>&1 || true

  if [[ -d "${dropin_dir}" ]]; then
    lp_log "removing timer drop-in directory ${dropin_dir}"
    rm -rf -- "${dropin_dir}"
  fi
}

# Removes the shared templates once nothing is left that could use them, so a
# host with no deployments carries none of this tooling's units.
lp_heartbeat_remove_templates_if_unused() {
  local file remaining=0

  for file in "${LP_UNIT_DIR}"/lp-workspace@*.service.d/"${LP_DEPLOY_DROPIN_NAME}"; do
    [[ -f "${file}" ]] && remaining="$((remaining + 1))"
  done

  [[ "${remaining}" -eq 0 ]] || return 0

  for file in "${LP_HEARTBEAT_TEMPLATE_SERVICE}" "${LP_HEARTBEAT_TEMPLATE_TIMER}"; do
    if [[ -f "${LP_UNIT_DIR}/${file}" ]]; then
      lp_log "removing shared unit ${LP_UNIT_DIR}/${file} (no deployments left)"
      rm -f -- "${LP_UNIT_DIR}/${file}"
    fi
  done

  rmdir "${LP_TELEMETRY_ROOT}" 2>/dev/null || true
  systemctl daemon-reload
}

# Seconds since the unit's main process started. Read from the monotonic clock
# systemd exposes rather than parsed out of a formatted timestamp, so it is
# unaffected by the host's timezone or a clock step.
lp_deploy_uptime_seconds() {
  local unit="$1" started_us now_us
  started_us="$(systemctl show "${unit}" -p ExecMainStartTimestampMonotonic --value 2>/dev/null || printf '0')"
  [[ "${started_us}" =~ ^[0-9]+$ ]] && [[ "${started_us}" != "0" ]] || { printf '0'; return 0; }
  now_us="$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)"
  printf '%s' "$(( (now_us - started_us) / 1000000 ))"
}

# Waits for the deployed service to answer. Polling rather than a single check
# because "started" and "listening" are different moments for every runtime.
#
# The attempt count is published because deployment.healthy carries it: a pack
# that answers on the first probe and one that answers on the twenty-ninth are
# different facts about cold start, and the difference is free to record here.
LP_DEPLOY_HEALTH_ATTEMPTS=0

lp_deploy_wait_healthy() {
  local url="$1" attempts="${2:-30}" attempt

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    LP_DEPLOY_HEALTH_ATTEMPTS="${attempt}"
    if curl -fsS -o /dev/null --max-time 3 "${url}" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done

  return 1
}
