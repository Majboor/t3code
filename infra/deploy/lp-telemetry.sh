#!/usr/bin/env bash
# Tier-1 telemetry for a deployment, as specified by docs/deployment.md.
#
# Sourced, never executed directly. Writes newline-delimited JSON to a
# per-deployment file that a control plane can collect later. There is
# deliberately no network sink and no server endpoint here: the contract says a
# deployment buffers to disk and replays, so disk is the primitive that has to
# exist first, and inventing a wire format before there is a collector would fix
# the wrong half of the problem.
#
# The event file is root-owned and lives outside the workspace directory. The
# workspace can therefore neither forge its own events nor read another
# deployment's, which is what lets an event be attributed to a pack digest
# without trusting the pack.
#
# Everything below is emitted by the runtime — the runner and the timer — with
# no cooperation from the pack. That is tier 1, and it is the tier the loop has
# to work from.

set -euo pipefail

[[ -n "${LP_TELEMETRY_SOURCED-}" ]] && return 0
LP_TELEMETRY_SOURCED=1

# One directory per deployment: the events, the refs the envelope is built from,
# and the small amount of state that makes an *absence* detectable.
readonly LP_TELEMETRY_ROOT="/var/lib/lp-telemetry"
readonly LP_TELEMETRY_EVENTS_NAME="events.ndjson"

# Heartbeat cadence, and the number of missed intervals after which silence is
# reported as `deployment.went_quiet`. Three is the figure docs/deployment.md
# names; it lives here so the timer unit and the synthesiser cannot disagree.
readonly LP_HEARTBEAT_INTERVAL_SECONDS=60
readonly LP_QUIET_AFTER_INTERVALS=3

lp_tel_dir_for() { printf '%s/%s' "${LP_TELEMETRY_ROOT}" "$1"; }
lp_tel_events_for() { printf '%s/%s' "$(lp_tel_dir_for "$1")" "${LP_TELEMETRY_EVENTS_NAME}"; }
lp_tel_state_dir_for() { printf '%s/state' "$(lp_tel_dir_for "$1")"; }

lp_tel_require_jq() {
  command -v jq >/dev/null 2>&1 \
    || lp_die "jq is required to emit telemetry (every event is JSON built by jq so a value can never be mis-escaped into it)"
}

# 0700 root:root. The pack runs as lp-<id> and so cannot read or append here.
lp_tel_init() {
  local id="$1" dir
  dir="$(lp_tel_dir_for "${id}")"

  mkdir -p "${dir}/state"
  chown -R root:root "${dir}"
  chmod 0700 "${LP_TELEMETRY_ROOT}" "${dir}" "${dir}/state"
  touch "$(lp_tel_events_for "${id}")"
  chmod 0600 "$(lp_tel_events_for "${id}")"
}

lp_tel_now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

# Crockford base32 over a millisecond timestamp and 16 random symbols. The
# eventId is the idempotency key for at-least-once delivery, so it has to be
# unique across the runner and the timer emitting concurrently — the randomness
# comes from /dev/urandom rather than $RANDOM for that reason.
lp_ulid() {
  local chars="0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  local out="" ts i byte

  ts="$(( $(date +%s) * 1000 + 10#$(date +%N) / 1000000 ))"
  for ((i = 0; i < 10; i++)); do
    out="${chars:$((ts % 32)):1}${out}"
    ts="$((ts / 32))"
  done

  for byte in $(od -An -v -tu1 -N16 /dev/urandom); do
    out+="${chars:$((byte % 32)):1}"
  done

  printf '%s' "${out}"
}

lp_tel_state_read() {
  local id="$1" key="$2" default="${3-}" file
  file="$(lp_tel_state_dir_for "${id}")/${key}"
  if [[ -f "${file}" ]]; then
    cat -- "${file}"
  else
    printf '%s' "${default}"
  fi
}

lp_tel_state_write() {
  local id="$1" key="$2" value="$3" dir
  dir="$(lp_tel_state_dir_for "${id}")"
  mkdir -p "${dir}"
  printf '%s' "${value}" >"${dir}/${key}"
  chmod 0600 "${dir}/${key}"
}

# The refs are written once at deploy time and read on every emission, so an
# event emitted by the timer an hour later carries exactly the attribution the
# deploy recorded rather than a second, drifting derivation of it.
lp_tel_write_ref() {
  local id="$1" name="$2" json="$3" dir
  dir="$(lp_tel_dir_for "${id}")"
  mkdir -p "${dir}"
  printf '%s\n' "${json}" >"${dir}/${name}.json"
  chmod 0600 "${dir}/${name}.json"
}

# Validated on the way out. A ref file that is empty or half-written must
# degrade one event to `null` attribution, not abort the deployment that was
# trying to describe itself.
lp_tel_read_ref() {
  local id="$1" name="$2" file
  file="$(lp_tel_dir_for "${id}")/${name}.json"
  if [[ -s "${file}" ]] && jq -e . "${file}" >/dev/null 2>&1; then
    cat -- "${file}"
  else
    printf 'null'
  fi
}

# Whole days since the deployment was first seen. Cheap to record now and, as
# the contract puts it, impossible to reconstruct later.
lp_tel_age_days() {
  local first_seen_epoch="$1" now
  now="$(date +%s)"
  if [[ -z "${first_seen_epoch}" ]]; then
    printf '0'
    return 0
  fi
  printf '%s' "$(( (now - first_seen_epoch) / 86400 ))"
}

# Appends one event. Payload must already be a JSON object; every other field of
# the envelope is assembled here so that no caller can omit one.
#
# `receivedAt` is null on purpose. The envelope requires the pair, and the second
# half is the control plane's clock — writing the deployment's clock into it
# would destroy the exact distinction the pair exists to make, which is a burst
# of failures versus a replayed hour.
lp_tel_emit() {
  local id="$1" type="$2" payload="$3"
  local dir events lock sequence pack deployment conditions run_id first_seen

  dir="$(lp_tel_dir_for "${id}")"
  [[ -d "${dir}" ]] || return 0

  events="$(lp_tel_events_for "${id}")"
  lock="${dir}/.emit.lock"

  pack="$(lp_tel_read_ref "${id}" pack-ref)"
  deployment="$(lp_tel_read_ref "${id}" deployment-ref)"
  conditions="$(lp_tel_read_ref "${id}" conditions)"
  run_id="$(lp_tel_state_read "${id}" run-id "")"
  first_seen="$(lp_tel_state_read "${id}" first-seen-epoch "")"

  # "Telemetry must never block the application" is a line in the contract, and
  # a runner that dies because it could not describe a deployment has inverted
  # exactly that. A payload that will not encode is dropped, loudly, and the
  # deploy carries on.
  if ! jq -e . >/dev/null 2>&1 <<<"${payload}"; then
    lp_warn "dropping a ${type} event: its payload is not valid JSON"
    return 0
  fi

  # The runner and the heartbeat timer both append, and `sequence` exists so
  # that gaps are visible — so the counter and the write happen under one lock
  # or two emitters could mint the same number.
  (
    flock 9
    sequence="$(( $(lp_tel_state_read "${id}" sequence 0) + 1 ))"
    lp_tel_state_write "${id}" sequence "${sequence}"

    jq -nc \
      --arg eventId "evt_$(lp_ulid)" \
      --arg type "${type}" \
      --arg occurredAt "$(lp_tel_now)" \
      --argjson sequence "${sequence}" \
      --argjson pack "${pack}" \
      --argjson deployment "${deployment}" \
      --argjson conditions "${conditions}" \
      --argjson payload "${payload}" \
      --arg runId "${run_id}" \
      --argjson ageDays "$(lp_tel_age_days "${first_seen}")" \
      '{
        schemaVersion: "1.0",
        eventId: $eventId,
        type: $type,
        occurredAt: $occurredAt,
        receivedAt: null,
        sequence: $sequence,
        pack: $pack,
        deployment: (
          if $deployment == null then null
          else $deployment
            + { deploymentRunId: (if $runId == "" then null else $runId end) }
            + { ageDays: $ageDays }
          end
        ),
        conditions: $conditions,
        payload: $payload
      }' >>"${events}" || lp_warn "could not write a ${type} event to ${events}"
  ) 9>"${lock}"

  chmod 0600 "${lock}" 2>/dev/null || true
}

# A new deploymentRunId on every process start, per the contract. Derived from
# the unit's main-process start timestamp rather than minted on a schedule, so a
# restart systemd performed while nothing was watching is still one run boundary
# and not a silently continued one.
lp_tel_run_token() {
  local unit="$1"
  systemctl show "${unit}" -p ExecMainStartTimestampMonotonic --value 2>/dev/null || printf ''
}

lp_tel_rotate_run_id() {
  local id="$1" token="$2" run_id
  run_id="run_$(lp_ulid)"
  lp_tel_state_write "${id}" run-id "${run_id}"
  lp_tel_state_write "${id}" run-token "${token}"
  printf '%s' "${run_id}"
}

lp_tel_remove() {
  local id="$1" dir
  dir="$(lp_tel_dir_for "${id}")"

  # Guarded the same way teardown guards rm -rf: the path is recomputed from the
  # namespace root and refused if it did not come out inside it.
  case "${dir}" in
    "${LP_TELEMETRY_ROOT}/"?*) : ;;
    *) lp_die "refusing to remove '${dir}': not inside ${LP_TELEMETRY_ROOT}" ;;
  esac

  [[ -d "${dir}" ]] || return 0
  rm -rf -- "${dir}"
}
