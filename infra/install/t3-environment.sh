#!/bin/sh
# Turn a Linux machine into a T3 environment, in one pasted line.
#
#   curl -fsSL <base-url>/install.sh | sh
#
# An environment is just a machine running the T3 server. The manual sequence
# for that — install a runtime, fetch the server, make a user, write a unit,
# join it to an account — is about fifteen steps that nobody performs the same
# way twice, so this performs them the same way every time.
#
# The design constraint that shapes the whole file: **the target box is already
# doing other work.** That is the normal case, not the exception. So this script
# creates exactly one user, one prefix, one state directory and one unit; it
# refuses rather than fighting anything already holding its port; and it never
# stops, disables or deletes a service it did not write itself. Every
# destructive step checks for the marker in T3_UNIT_MARKER first.
#
# POSIX sh on purpose. It runs before any runtime exists, on whatever /bin/sh
# the distribution ships. That makes it a bad place to keep judgement, so the
# judgement lives in scripts/lib/environment-install.ts where it has tests, and
# the constants block below is mechanically compared against that module by
# scripts/lib/environment-install.test.ts. If you change a value here, that test
# tells you about the other copy.
#
# Read the plan before trusting it: `sh t3-environment.sh --dry-run`.

set -eu

# --- drift-checked constants ---
# Plain NAME="value" lines, no expansion, because environment-install.test.ts
# parses this block as text. Anything cleverer here would have to be executed
# to be read, and executing an installer to test it is not a trade worth making.
T3_PREFIX="/opt/t3-environment"
T3_DATA_DIR="/var/lib/t3-environment"
T3_SERVICE_USER="t3env"
T3_UNIT_NAME="t3-environment.service"
T3_UNIT_PATH="/etc/systemd/system/t3-environment.service"
T3_UNIT_MARKER="# Managed by t3-environment.sh"
T3_DEFAULT_PORT="3773"
T3_BUN_VERSION="1.3.11"
T3_SERVER_VERSION="0.0.20"
T3_ENROLL_STATUS_COLLECTED="200"
T3_ENROLL_STATUS_WAIT="425"
T3_ENROLL_STATUS_RATE_LIMITED="429"
T3_ENROLL_POLL_INTERVAL_SECONDS="2"
T3_ENROLL_RATE_LIMIT_SECONDS="15"
T3_ENROLL_TTL_SECONDS="600"
# Where a published release would live. NOTHING PUBLISHES ONE YET, so this is
# empty and the script refuses at the download step with a plain explanation
# rather than fetching a URL somebody invented to make the docs look finished.
# Mirrors ENVIRONMENT_INSTALL_BASE_URL in scripts/lib/environment-install.ts.
# Override for your own artifacts with --base-url.
T3_INSTALL_BASE_URL=""
# --- end drift-checked constants ---

# Overridable for testing in a throwaway container. Not documented as a
# supported way to run a real environment: two installs under different
# prefixes would still contend for the one unit name.
T3_PREFIX="${T3_INSTALL_PREFIX:-$T3_PREFIX}"
T3_DATA_DIR="${T3_INSTALL_DATA_DIR:-$T3_DATA_DIR}"

T3_RUNTIME_DIR="$T3_PREFIX/runtime"
T3_SERVER_DIR="$T3_PREFIX/server"
T3_BUN_BIN="$T3_RUNTIME_DIR/bin/bun"
T3_ENTRYPOINT="$T3_SERVER_DIR/dist/bin.mjs"
T3_VERSION_FILE="$T3_PREFIX/VERSION"
T3_SELF_COPY="$T3_PREFIX/libexec/t3-environment.sh"
T3_ENROLLMENT_FILE="$T3_DATA_DIR/enrollment.json"

# --- output ----------------------------------------------------------------
# Defined before the option parser, because the option parser is the first thing
# that can need to refuse.
log() { printf 't3: %s\n' "$*" >&2; }
warn() { printf 't3: WARNING: %s\n' "$*" >&2; }
note() { printf '    %s\n' "$*" >&2; }

# Refusals go to stderr and exit non-zero, and every one of them says what state
# the machine was left in. A script that pipes into a shell gets one chance to
# explain itself; "error" is not an explanation.
die() {
  printf 't3: ERROR: %s\n' "$*" >&2
  exit 1
}

# --- options ---------------------------------------------------------------
opt_dry_run=0
opt_uninstall=0
opt_port="$T3_DEFAULT_PORT"
opt_host="127.0.0.1"
opt_version="$T3_SERVER_VERSION"
opt_base_url="$T3_INSTALL_BASE_URL"
opt_account_url=""
opt_label=""

usage() {
  cat <<EOF
Turn this machine into a T3 environment.

Usage:
  t3-environment.sh [options]
  t3-environment.sh --uninstall

Options:
  --dry-run              Print the plan and change nothing.
  --uninstall            Remove the unit, the user and the prefix. Keeps data.
  --account-url <url>    The T3 server you are signed in to. Enrolls this
                         machine into that account; prints a link to approve.
                         Omitted, the server is installed but joins no account.
  --host <address>       Interface to bind (default 127.0.0.1).
  --port <number>        Port to bind (default $T3_DEFAULT_PORT).
  --version <version>    Server version to install (default $T3_SERVER_VERSION).
  --base-url <url>       Where to fetch the server tarball from.
  --label <text>         How this machine should appear in the approval screen
                         and the account's machine list (default: hostname).
  -h, --help             Show this.

Installs:
  $T3_PREFIX          runtime + server (removed by --uninstall)
  $T3_DATA_DIR      database, logs, worktrees (KEPT by --uninstall)
  $T3_UNIT_PATH
  a system user named $T3_SERVICE_USER

Nothing else on the machine is touched. Ports in use, services this script did
not install, and package state are all left exactly as they were.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --dry-run)
      opt_dry_run=1
      shift
      ;;
    --uninstall)
      opt_uninstall=1
      shift
      ;;
    --account-url)
      [ $# -ge 2 ] || die "--account-url needs a value"
      opt_account_url="$2"
      shift 2
      ;;
    --host)
      [ $# -ge 2 ] || die "--host needs a value"
      opt_host="$2"
      shift 2
      ;;
    --port)
      [ $# -ge 2 ] || die "--port needs a value"
      opt_port="$2"
      shift 2
      ;;
    --version)
      [ $# -ge 2 ] || die "--version needs a value"
      opt_version="$2"
      shift 2
      ;;
    --base-url)
      [ $# -ge 2 ] || die "--base-url needs a value"
      opt_base_url="$2"
      shift 2
      ;;
    --label)
      [ $# -ge 2 ] || die "--label needs a value"
      opt_label="$2"
      shift 2
      ;;
    *)
      printf 't3: unknown option "%s" (try --help)\n' "$1" >&2
      exit 2
      ;;
  esac
done

# In a dry run this is the whole program: describe, never execute. Used for
# every command that changes the machine, so --dry-run is a property of the
# script rather than something each step remembers to honour.
run() {
  if [ "$opt_dry_run" -eq 1 ]; then
    printf '    would run: %s\n' "$*" >&2
    return 0
  fi
  "$@"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "must run as root: creating a system user and a systemd unit needs it. Re-run with sudo."
  fi
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 ||
    die "'$1' is not installed, and this script does not install system packages on a machine it does not own. Install it ($2) and re-run."
}

# --- platform --------------------------------------------------------------
# Mirrors detectInstallPlatform() in scripts/lib/environment-install.ts. Kernel
# first, then architecture, then init: a person on a Mac should be told they are
# on a Mac, not told about their CPU.
detect_platform() {
  detect_kernel="$(uname -s 2>/dev/null || printf '')"
  detect_machine="$(uname -m 2>/dev/null || printf '')"

  case "$detect_kernel" in
    Linux) ;;
    Darwin)
      die "this installer is for Linux servers, and this is macOS. Nothing was installed. On a Mac, run 't3 serve' directly, or use the desktop app."
      ;;
    FreeBSD | OpenBSD | NetBSD | DragonFly | SunOS)
      die "this installer is for Linux servers, and this is $detect_kernel. There is no build for it, so nothing was installed."
      ;;
    MINGW* | MSYS* | CYGWIN*)
      die "this installer is for Linux servers, and this looks like Windows ($detect_kernel). Nothing was installed. Use the desktop app, or install into WSL2 with systemd enabled."
      ;;
    "")
      die "could not read 'uname -s', so this machine could not be identified. Nothing was installed."
      ;;
    *)
      die "this installer is for Linux servers, and 'uname -s' reports \"$detect_kernel\". Nothing was installed."
      ;;
  esac

  case "$detect_machine" in
    x86_64 | amd64) T3_ARCH="x64" ;;
    aarch64 | arm64) T3_ARCH="aarch64" ;;
    *)
      die "this installer supports x86_64 and aarch64 Linux; this machine reports \"$detect_machine\". There is no build for it, so nothing was installed."
      ;;
  esac

  # The *running* init, not merely an installed package. A container with the
  # systemd binaries present but PID 1 elsewhere has no /run/systemd/system, and
  # installing a unit there produces a service that never starts.
  if [ ! -d /run/systemd/system ]; then
    die "this installer needs systemd as the running init, and /run/systemd/system is not present. That is normal inside a plain container or on a runit/OpenRC host. Nothing was installed; run the server under whatever supervisor this machine already uses."
  fi

  T3_BUN_ASSET="bun-linux-$T3_ARCH"
}

# --- port conflicts --------------------------------------------------------
# The rule mirrors findPortConflict() in scripts/lib/environment-install.ts, and
# it is not "is anything on this port". A box can legitimately run one service on
# 127.0.0.1:3773 and another on a public address; refusing on the first would
# make this unusable on exactly the hosts it was written for. A wildcard on
# either side collides with everything; two specific addresses collide only with
# themselves.
#
# Prints "<pid><tab><description>", or nothing. The pid is separated out because
# the caller has to answer a second question after "is this port taken": is the
# thing holding it *our own service*, which an upgrade must tolerate. Only the
# pid settles that — see conflictIsOwnService() in the TypeScript module.
find_port_conflict() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -lntpH 2>/dev/null | awk -v want_port="$1" -v want_host="$2" '
    {
      local = $4
      pos = 0
      for (i = length(local); i > 0; i--) {
        if (substr(local, i, 1) == ":") { pos = i; break }
      }
      if (pos == 0) next
      port = substr(local, pos + 1)
      if (port !~ /^[0-9]+$/) next
      if (port + 0 != want_port + 0) next

      addr = substr(local, 1, pos - 1)
      gsub(/^\[/, "", addr); gsub(/\]$/, "", addr)
      sub(/^::ffff:/, "", addr)

      wildcard_want = (want_host == "0.0.0.0" || want_host == "::" || want_host == "*")
      wildcard_have = (addr == "0.0.0.0" || addr == "::" || addr == "*" || addr == "")
      if (!wildcard_want && !wildcard_have && addr != want_host) next

      proc = ""
      for (i = 6; i <= NF; i++) proc = proc " " $i
      if (addr == "") addr = "*"

      pid = ""
      if (match(proc, /pid=[0-9]+/)) {
        pid = substr(proc, RSTART + 4, RLENGTH - 4)
      }
      printf "%s\t%s:%s%s\n", pid, addr, port, proc
      exit
    }
  '
}

# The pid systemd believes is our server, or empty. `MainPID` is 0 for a unit
# that is not running, and 0 is filtered here rather than at the call site so
# that "not running" and "no such unit" produce the same empty answer.
own_service_pid() {
  own_service_pid_value="$(
    systemctl show -p MainPID --value "$T3_UNIT_NAME" 2>/dev/null || printf ''
  )"
  case "$own_service_pid_value" in
    '' | 0 | *[!0-9]*) printf '' ;;
    *) printf '%s' "$own_service_pid_value" ;;
  esac
}

# True only for a unit this script wrote. Everything destructive is gated on it,
# so a hand-rolled service that happens to share the name survives untouched.
unit_is_ours() {
  [ -f "$T3_UNIT_PATH" ] && head -n 1 "$T3_UNIT_PATH" 2>/dev/null | grep -qxF "$T3_UNIT_MARKER"
}

installed_version() {
  if [ -f "$T3_VERSION_FILE" ]; then
    tr -d ' \t\n' <"$T3_VERSION_FILE"
  fi
}

# --- plan ------------------------------------------------------------------
# Printed before anything is touched, every run, dry or not. Anyone pasting a
# pipe-to-shell line is entitled to see the list of things about to change on
# their machine, and to see it from the script rather than from documentation
# that may describe a different version.
print_install_plan() {
  plan_installed="$(installed_version)"
  printf '\n' >&2
  log "plan for $(hostname 2>/dev/null || printf 'this machine')"
  note "install    T3 server $opt_version + bun $T3_BUN_VERSION into $T3_PREFIX"
  note "data       $T3_DATA_DIR (created if absent, never overwritten)"
  note "user       system account '$T3_SERVICE_USER', no shell, no password"
  note "service    $T3_UNIT_PATH, restart on failure, start at boot"
  note "listen     $opt_host:$opt_port"
  if [ -n "$opt_account_url" ]; then
    note "enroll     into the account at $opt_account_url (you approve it in a browser)"
  else
    note "enroll     skipped: no --account-url given, so this joins no account"
  fi
  if [ "$plan_installed" = "$opt_version" ]; then
    note "existing   $plan_installed is already installed; this reinstalls it over itself"
  elif [ -n "$plan_installed" ]; then
    note "existing   $plan_installed is installed here; this replaces it in place"
  fi
  printf '\n' >&2
  note "Nothing else is modified. No packages are installed, no other service is"
  note "stopped, and $T3_DATA_DIR survives --uninstall."
  printf '\n' >&2
}

# --- preflight -------------------------------------------------------------
preflight() {
  require_tool curl "curl"
  require_tool tar "tar"
  require_tool unzip "unzip"
  require_tool awk "gawk or mawk"

  case "$opt_port" in
    '' | *[!0-9]*) die "--port must be a number, got \"$opt_port\"" ;;
  esac
  [ "$opt_port" -ge 1 ] && [ "$opt_port" -le 65535 ] ||
    die "--port must be between 1 and 65535, got $opt_port"

  # Asked here, before anything is created, rather than at the moment we would
  # write the file. Discovering somebody else's unit only after making a user,
  # downloading a runtime and unpacking a server leaves a busy box carrying the
  # debris of an install that was never going to finish.
  if [ -f "$T3_UNIT_PATH" ] && ! unit_is_ours; then
    printf '\n' >&2
    die "$T3_UNIT_PATH already exists and was not written by this script.

    Refusing to touch it. Something else on this machine owns that unit name.
    Nothing was installed, nothing was started, and nothing was stopped.
    Move that unit aside if it is stale, then run this again."
  fi

  # Version comparison, deliberately narrow: shell can tell "same" from
  # "different" reliably and cannot tell "older" from "newer" reliably, so the
  # ordering question is only ever asked of the tested implementation. Here we
  # only need to know whether this is a fresh install.
  preflight_installed="$(installed_version)"
  if [ -n "$preflight_installed" ]; then
    if [ "$preflight_installed" = "$opt_version" ]; then
      log "version $opt_version is already installed; reinstalling over it. Data is untouched."
    else
      log "upgrading $preflight_installed -> $opt_version in place. Data is untouched."
    fi
  fi

  # Our own running service is not a conflict — it is the thing being upgraded,
  # and it gets stopped further down. Anything else is, and "anything else"
  # includes a stranger's process that took the port while our service happened
  # to be stopped. Only a pid match proves ownership; the presence of an install
  # proves nothing.
  preflight_conflict="$(find_port_conflict "$opt_port" "$opt_host")"
  if [ -n "$preflight_conflict" ]; then
    preflight_conflict_pid="$(printf '%s' "$preflight_conflict" | cut -f1)"
    preflight_conflict_desc="$(printf '%s' "$preflight_conflict" | cut -f2-)"
    preflight_own_pid="$(own_service_pid)"

    if unit_is_ours &&
      [ -n "$preflight_conflict_pid" ] &&
      [ -n "$preflight_own_pid" ] &&
      [ "$preflight_conflict_pid" = "$preflight_own_pid" ]; then
      log "port $opt_port is held by this environment's own service (pid $preflight_conflict_pid); it will be restarted"
    else
      printf '\n' >&2
      die "port $opt_port is already in use on this machine, by:
       $preflight_conflict_desc

    Nothing was installed and nothing was stopped — that socket belongs to
    something this script did not put there, and taking it would break whatever
    is using it. Re-run with --port <other> to bind somewhere free."
    fi
  elif ! command -v ss >/dev/null 2>&1; then
    warn "'ss' is not installed, so the port conflict check was skipped. If $opt_port is taken, the service will fail to start and nothing else will be affected."
  fi

  if [ -z "$opt_base_url" ]; then
    printf '\n' >&2
    die "there is no published release to install.

    No job builds a server tarball and no job uploads one anywhere, so this
    script has nowhere to fetch $opt_version from and will not guess at a URL.
    Nothing was installed.

    To install from your own artifacts, host a directory containing
    t3-server-<version>.tar.gz and re-run with:

      --base-url https://your-host/path

    See infra/install/README.md."
  fi
}

# --- steps -----------------------------------------------------------------
ensure_user() {
  if id -u "$T3_SERVICE_USER" >/dev/null 2>&1; then
    log "user $T3_SERVICE_USER already exists; leaving its uid alone"
    return 0
  fi

  # First shell that exists. A --shell pointing at a missing path makes an
  # account systemd can still run but nothing else can reason about.
  ensure_user_shell=/bin/false
  for candidate in /usr/sbin/nologin /sbin/nologin /usr/bin/nologin; do
    if [ -x "$candidate" ]; then
      ensure_user_shell="$candidate"
      break
    fi
  done

  log "creating system user $T3_SERVICE_USER"
  # --system keeps it out of the human uid range so it is never mistaken for an
  # operator login; no shell and no password mean it cannot be used to reach the
  # box over SSH or su.
  run useradd --system \
    --home-dir "$T3_DATA_DIR" \
    --no-create-home \
    --shell "$ensure_user_shell" \
    --comment "T3 Code environment" \
    "$T3_SERVICE_USER" ||
    die "useradd failed for $T3_SERVICE_USER"
}

ensure_directories() {
  log "ensuring $T3_PREFIX and $T3_DATA_DIR"
  run mkdir -p "$T3_PREFIX" "$T3_PREFIX/libexec" "$T3_RUNTIME_DIR" "$T3_SERVER_DIR" "$T3_DATA_DIR"
  # The prefix is code: root-owned, world-readable, not writable by the service.
  # A service that can rewrite its own binaries is a service whose compromise is
  # permanent.
  run chown root:root "$T3_PREFIX"
  run chmod 0755 "$T3_PREFIX"
  # The data directory is the opposite: the service owns it and nobody else
  # reads it, because it holds the database, the tokens and somebody's code.
  run chown "$T3_SERVICE_USER:$T3_SERVICE_USER" "$T3_DATA_DIR"
  run chmod 0700 "$T3_DATA_DIR"
}

# bun comes from oven-sh's own GitHub release, pinned by version, rather than
# from `curl https://bun.sh/install | bash`. Two reasons: that installer needs
# bash and writes into $HOME, and a second unpinned pipe-to-shell inside a
# pipe-to-shell is one more thing nobody read.
install_runtime() {
  if [ -x "$T3_BUN_BIN" ] &&
    [ "$("$T3_BUN_BIN" --version 2>/dev/null || printf '')" = "$T3_BUN_VERSION" ]; then
    log "bun $T3_BUN_VERSION already present"
    return 0
  fi

  install_runtime_url="https://github.com/oven-sh/bun/releases/download/bun-v$T3_BUN_VERSION/$T3_BUN_ASSET.zip"
  log "downloading bun $T3_BUN_VERSION ($T3_BUN_ASSET)"

  if [ "$opt_dry_run" -eq 1 ]; then
    note "would download $install_runtime_url"
    note "would unpack it to $T3_RUNTIME_DIR/bin/bun"
    return 0
  fi

  install_runtime_tmp="$(mktemp -d)" || die "could not create a temporary directory"
  curl -fsSL "$install_runtime_url" -o "$install_runtime_tmp/bun.zip" || {
    rm -rf "$install_runtime_tmp"
    die "could not download bun from $install_runtime_url"
  }
  unzip -q "$install_runtime_tmp/bun.zip" -d "$install_runtime_tmp" || {
    rm -rf "$install_runtime_tmp"
    die "could not unpack the bun archive"
  }
  mkdir -p "$T3_RUNTIME_DIR/bin"
  install -m 0755 "$install_runtime_tmp/$T3_BUN_ASSET/bun" "$T3_BUN_BIN" || {
    rm -rf "$install_runtime_tmp"
    die "could not install bun into $T3_BUN_BIN"
  }
  rm -rf "$install_runtime_tmp"
  log "bun $("$T3_BUN_BIN" --version) installed"
}

install_server() {
  install_server_url="${opt_base_url%/}/t3-server-$opt_version.tar.gz"
  log "downloading T3 server $opt_version"

  if [ "$opt_dry_run" -eq 1 ]; then
    note "would download $install_server_url"
    note "would unpack it to $T3_SERVER_DIR"
    note "would write $T3_VERSION_FILE"
    return 0
  fi

  install_server_tmp="$(mktemp -d)" || die "could not create a temporary directory"
  curl -fsSL "$install_server_url" -o "$install_server_tmp/server.tar.gz" || {
    rm -rf "$install_server_tmp"
    die "could not download the server from $install_server_url"
  }

  # Unpacked beside the live directory and swapped, so a truncated download
  # cannot leave a half-replaced install where a working one used to be.
  mkdir -p "$install_server_tmp/unpacked"
  tar -xzf "$install_server_tmp/server.tar.gz" -C "$install_server_tmp/unpacked" || {
    rm -rf "$install_server_tmp"
    die "could not unpack the server archive"
  }
  rm -rf "$T3_SERVER_DIR.old"
  if [ -d "$T3_SERVER_DIR" ]; then
    mv "$T3_SERVER_DIR" "$T3_SERVER_DIR.old"
  fi
  mv "$install_server_tmp/unpacked" "$T3_SERVER_DIR"
  rm -rf "$T3_SERVER_DIR.old" "$install_server_tmp"

  [ -f "$T3_ENTRYPOINT" ] ||
    die "the archive did not contain $T3_ENTRYPOINT. The previous install is at $T3_SERVER_DIR and the service was not changed."

  printf '%s\n' "$opt_version" >"$T3_VERSION_FILE"
  chmod 0644 "$T3_VERSION_FILE"
  chown -R root:root "$T3_SERVER_DIR"
  log "server $opt_version installed"
}

# Kept beside the install so removal never depends on still having the URL, the
# network, or the terminal scrollback from three months ago.
install_uninstaller() {
  install_uninstaller_url="${opt_base_url%/}/install.sh"
  if [ "$opt_dry_run" -eq 1 ]; then
    note "would place a copy of this script at $T3_SELF_COPY for --uninstall"
    return 0
  fi
  mkdir -p "$T3_PREFIX/libexec"
  if [ -f "$0" ] && [ -r "$0" ]; then
    install -m 0755 "$0" "$T3_SELF_COPY"
  elif curl -fsSL "$install_uninstaller_url" -o "$T3_SELF_COPY" 2>/dev/null; then
    chmod 0755 "$T3_SELF_COPY"
  else
    warn "could not save a copy of this script for uninstalling. To remove later: systemctl disable --now $T3_UNIT_NAME; rm $T3_UNIT_PATH; userdel $T3_SERVICE_USER; rm -rf $T3_PREFIX"
    return 0
  fi
  log "uninstaller saved at $T3_SELF_COPY"
}

write_unit() {
  log "writing $T3_UNIT_PATH"

  if [ -f "$T3_UNIT_PATH" ] && ! unit_is_ours; then
    die "$T3_UNIT_PATH already exists and was not written by this script.

    Refusing to overwrite it. Something else on this machine owns that unit
    name; nothing has been started or stopped. Move it aside if it is stale."
  fi

  if [ "$opt_dry_run" -eq 1 ]; then
    note "would write a systemd unit running as $T3_SERVICE_USER, Restart=on-failure, WantedBy=multi-user.target"
    return 0
  fi

  # Hardened, but deliberately not as hard as infra/host/lp-workspace@.service.
  # That unit confines a single known workload; this one supervises an agent
  # server whose entire job is to run git, package managers and whatever
  # toolchain a person's project needs. ProtectSystem=strict, ProtectHome=yes
  # and a system call filter would each break that in ways that surface much
  # later as an unexplained failure inside somebody's build. What is set below
  # is the subset that costs nothing: no privilege escalation, no writing to
  # /usr or /etc, no reaching the kernel's knobs.
  cat >"$T3_UNIT_PATH" <<EOF
$T3_UNIT_MARKER
# Written by infra/install/t3-environment.sh. Edits are lost on the next run;
# change the script instead.

[Unit]
Description=T3 Code environment
After=network-online.target
Wants=network-online.target
# The server cannot run without its data directory, and a unit that restarts
# forever against a missing one is just a way to fill the journal.
ConditionPathIsDirectory=$T3_DATA_DIR
# Bounds a crash loop so a broken install degrades this service rather than the
# machine's CPU and journal. Must be in [Unit]; systemd ignores it in [Service].
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$T3_SERVICE_USER
Group=$T3_SERVICE_USER
WorkingDirectory=$T3_DATA_DIR

Environment=T3CODE_HOME=$T3_DATA_DIR
Environment=T3CODE_HOST=$opt_host
Environment=T3CODE_PORT=$opt_port
Environment=T3CODE_NO_BROWSER=true
Environment=HOME=$T3_DATA_DIR

ExecStart=$T3_BUN_BIN $T3_ENTRYPOINT serve

Restart=on-failure
RestartSec=5s

# Neuters every setuid binary on the host for this process and its children,
# whatever the file permissions say.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ReadWritePaths=$T3_DATA_DIR
UMask=0077
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$T3_UNIT_PATH"
  run systemctl daemon-reload
}

# --- enrollment ------------------------------------------------------------
# The flow in apps/server/src/deviceEnrollment/http.ts, unchanged and not
# extended: create, print the approve link, poll collect. No second mechanism,
# no token minted here, nothing that works without a real person clicking
# approve in a browser where they are already signed in.
#
# The reply is JSON and this is POSIX sh, so the runtime installed two steps
# ago does the reading. Arguments travel in the environment rather than in
# argv, for two reasons: `bun -e` does not insert a script path into `Bun.argv`
# the way `bun file.ts` does, so index-based slicing there is off by one and
# fails silently into "no value"; and an enrollment code is a bearer credential
# that has no business appearing in a command line other processes can read.
json_field() {
  T3_JSON_FILE="$1" T3_JSON_KEY="$2" "$T3_BUN_BIN" -e '
    const value = JSON.parse(await Bun.file(process.env.T3_JSON_FILE).text())[
      process.env.T3_JSON_KEY
    ];
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  ' 2>/dev/null || printf ''
}

enroll() {
  [ -n "$opt_account_url" ] || return 0

  enroll_label="$opt_label"
  [ -n "$enroll_label" ] || enroll_label="$(hostname 2>/dev/null || printf 'a Linux server')"
  enroll_base="${opt_account_url%/}"

  if [ "$opt_dry_run" -eq 1 ]; then
    log "would enroll this machine into $enroll_base"
    note "would POST $enroll_base/api/devices/enrollments"
    note "would print an approval link for you to open, then poll until you approve it"
    return 0
  fi

  enroll_dir="$(mktemp -d)" || die "could not create a temporary directory"
  # 0700 because the enrollment code in these files is a bearer credential for
  # the length of the exchange, and /tmp is shared with everything else on the
  # box.
  chmod 0700 "$enroll_dir"

  # Built by the runtime rather than by printf. The label reaches here from
  # --label or from `hostname`, and a single quote or backslash in it would turn
  # a hand-assembled body into malformed JSON — which the server would answer
  # with an error that says nothing about the real cause. JSON.stringify is the
  # one thing on this machine that is guaranteed to get the escaping right.
  enroll_body="$(
    T3_LABEL="$enroll_label" T3_PLATFORM="linux-$T3_ARCH" "$T3_BUN_BIN" -e '
      process.stdout.write(
        JSON.stringify({
          deviceLabel: process.env.T3_LABEL,
          devicePlatform: process.env.T3_PLATFORM,
        }),
      );
    '
  )" || die "could not build the enrollment request"

  log "asking $enroll_base to enroll this machine"
  enroll_status="$(
    curl -sS -o "$enroll_dir/create.json" -w '%{http_code}' \
      -X POST "$enroll_base/api/devices/enrollments" \
      -H 'content-type: application/json' \
      --data "$enroll_body" \
      2>/dev/null || printf '000'
  )"

  if [ "$enroll_status" != "201" ]; then
    rm -rf "$enroll_dir"
    warn "could not start enrollment: $enroll_base answered $enroll_status."
    note "The environment is installed and running; it just has not joined an account."
    note "Re-run with --account-url once the account server is reachable."
    return 0
  fi

  enroll_code="$(json_field "$enroll_dir/create.json" code)"
  enroll_url="$(json_field "$enroll_dir/create.json" approveUrl)"
  if [ -z "$enroll_code" ] || [ -z "$enroll_url" ]; then
    rm -rf "$enroll_dir"
    warn "the enrollment reply was not in a shape this script understands; skipping enrollment"
    return 0
  fi

  printf '\n' >&2
  log "open this in a browser where you are signed in, and approve this machine:"
  printf '\n    %s\n\n' "$enroll_url" >&2
  note "waiting up to $((T3_ENROLL_TTL_SECONDS / 60)) minutes. Ctrl-C leaves the machine installed but unenrolled."

  enroll_waited=0
  while [ "$enroll_waited" -lt "$T3_ENROLL_TTL_SECONDS" ]; do
    enroll_status="$(
      curl -sS -o "$enroll_dir/collect.json" -w '%{http_code}' \
        -X POST "$enroll_base/api/devices/enrollments/$enroll_code/collect" \
        2>/dev/null || printf '000'
    )"

    # The table is decideEnrollmentPoll() in scripts/lib/environment-install.ts.
    # 425 against 409 is the whole loop: 425 means the person has not clicked
    # yet and the same request works later; 409 means this code is finished
    # forever. Treating them alike either abandons a live enrollment or hammers
    # a dead one until the deadline.
    case "$enroll_status" in
      "$T3_ENROLL_STATUS_COLLECTED")
        install -m 0600 -o "$T3_SERVICE_USER" -g "$T3_SERVICE_USER" \
          "$enroll_dir/collect.json" "$T3_ENROLLMENT_FILE"
        rm -rf "$enroll_dir"
        log "approved. This machine is now in your account."
        note "Its credential is at $T3_ENROLLMENT_FILE (readable only by $T3_SERVICE_USER)."
        note "Revoke it any time from the connected machines list in your account."
        return 0
        ;;
      "$T3_ENROLL_STATUS_WAIT")
        sleep "$T3_ENROLL_POLL_INTERVAL_SECONDS"
        enroll_waited=$((enroll_waited + T3_ENROLL_POLL_INTERVAL_SECONDS))
        ;;
      "$T3_ENROLL_STATUS_RATE_LIMITED" | 503 | 000)
        sleep "$T3_ENROLL_RATE_LIMIT_SECONDS"
        enroll_waited=$((enroll_waited + T3_ENROLL_RATE_LIMIT_SECONDS))
        ;;
      409)
        rm -rf "$enroll_dir"
        warn "this enrollment is finished — it was denied, it expired, or it has already been used."
        note "The environment is installed and running. Re-run with --account-url to try again."
        return 0
        ;;
      *)
        rm -rf "$enroll_dir"
        warn "the account server answered $enroll_status while collecting; giving up on enrollment."
        note "Check that --account-url points at the server you are signed in to."
        note "The environment is installed and running."
        return 0
        ;;
    esac
  done

  rm -rf "$enroll_dir"
  warn "nobody approved this machine before the window closed."
  note "The environment is installed and running. Re-run with --account-url for a fresh link."
}

# --- lifecycle -------------------------------------------------------------
start_service() {
  # Stopped only because it is ours, and only when it is already running. This
  # is the one place the script could plausibly interrupt something on a busy
  # box, so it is gated on the marker rather than on the unit name.
  if unit_is_ours && systemctl is-active --quiet "$T3_UNIT_NAME" 2>/dev/null; then
    log "stopping the existing $T3_UNIT_NAME to replace it"
    run systemctl stop "$T3_UNIT_NAME"
  fi

  log "enabling $T3_UNIT_NAME at boot and starting it"
  run systemctl enable "$T3_UNIT_NAME"
  run systemctl restart "$T3_UNIT_NAME"

  if [ "$opt_dry_run" -eq 1 ]; then
    return 0
  fi

  # A unit that fails two seconds after start is the commonest bad outcome, and
  # a script that exits 0 into it has told somebody a lie.
  sleep 2
  if ! systemctl is-active --quiet "$T3_UNIT_NAME"; then
    warn "$T3_UNIT_NAME did not stay running. Nothing else on this machine was changed."
    note "journalctl -u $T3_UNIT_NAME -n 50 --no-pager"
    return 1
  fi
  log "running on $opt_host:$opt_port"
}

do_install() {
  # Platform before privilege, deliberately. "Run this again with sudo", and
  # then after they do, "actually this is macOS" is two round trips to deliver
  # one refusal — and the second one costs somebody a root shell they did not
  # need to open.
  detect_platform
  log "platform: linux-$T3_ARCH, systemd present"

  require_root
  print_install_plan

  if [ "$opt_dry_run" -eq 1 ]; then
    log "dry run: nothing below is executed"
  fi

  preflight
  ensure_user
  ensure_directories
  install_runtime
  install_server
  install_uninstaller
  write_unit
  start_service
  enroll

  printf '\n' >&2
  if [ "$opt_dry_run" -eq 1 ]; then
    log "dry run complete. Nothing was changed."
    return 0
  fi
  log "done."
  note "status     systemctl status $T3_UNIT_NAME"
  note "logs       journalctl -u $T3_UNIT_NAME -f"
  note "remove     sudo $T3_SELF_COPY --uninstall"
}

# --- uninstall -------------------------------------------------------------
# Removes exactly what installing created, refuses anything it did not, and says
# out loud what it is leaving behind. A removal that silently took the database
# with it would be the worst bug in this file.
do_uninstall() {
  require_root

  printf '\n' >&2
  log "uninstall plan"
  note "stop and disable  $T3_UNIT_NAME (only if this script wrote it)"
  note "remove            $T3_UNIT_PATH"
  note "remove            $T3_PREFIX"
  note "remove            system user $T3_SERVICE_USER"
  note "KEEP              $T3_DATA_DIR — your database, logs and worktrees"
  printf '\n' >&2

  if [ -f "$T3_UNIT_PATH" ]; then
    if unit_is_ours; then
      log "stopping and disabling $T3_UNIT_NAME"
      # No output redirection on these: `run` announces itself on stderr in a
      # dry run, and a redirect here would silently swallow the two lines that
      # tell somebody their uninstall is about to stop a running service.
      run systemctl disable --now "$T3_UNIT_NAME" || true
      run rm -f "$T3_UNIT_PATH"
      run systemctl daemon-reload
      # Only when there is a failed state to clear; on a unit that exited
      # cleanly this command is an error message and nothing else.
      if systemctl is-failed --quiet "$T3_UNIT_NAME" 2>/dev/null; then
        run systemctl reset-failed "$T3_UNIT_NAME" || true
      fi
    else
      warn "$T3_UNIT_PATH exists but was not written by this script; leaving it alone"
    fi
  else
    log "no unit at $T3_UNIT_PATH; already gone"
  fi

  if [ -d "$T3_PREFIX" ]; then
    log "removing $T3_PREFIX"
    run rm -rf "$T3_PREFIX"
  else
    log "no prefix at $T3_PREFIX; already gone"
  fi

  if id -u "$T3_SERVICE_USER" >/dev/null 2>&1; then
    log "removing user $T3_SERVICE_USER"
    # No --remove: that flag deletes the home directory, and the home directory
    # is the data directory this whole function promises to keep.
    run userdel "$T3_SERVICE_USER" || warn "userdel failed for $T3_SERVICE_USER"
  else
    log "no user $T3_SERVICE_USER; already gone"
  fi

  printf '\n' >&2
  if [ "$opt_dry_run" -eq 1 ]; then
    log "dry run complete. Nothing was changed."
    return 0
  fi
  log "uninstalled."
  if [ -d "$T3_DATA_DIR" ]; then
    note "LEFT BEHIND: $T3_DATA_DIR ($(du -sh "$T3_DATA_DIR" 2>/dev/null | cut -f1 || printf 'unknown size'))"
    note "That is your database, logs and worktrees. Reinstalling picks it up again."
    note "To remove it too:  sudo rm -rf $T3_DATA_DIR"
  fi
}

if [ "$opt_uninstall" -eq 1 ]; then
  do_uninstall
else
  do_install
fi
