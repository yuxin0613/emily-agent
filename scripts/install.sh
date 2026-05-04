#!/usr/bin/env bash
# Emily AgentOS installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/yuxin0613/emily-agent/master/scripts/install.sh | bash
#
# Options:
#   bash install.sh --branch master --dir ~/.emily/emily-agent --bin-dir ~/.local/bin

set -euo pipefail

REPO_URL="${EMILY_REPO_URL:-https://github.com/yuxin0613/emily-agent.git}"
BRANCH="${EMILY_BRANCH:-master}"
EMILY_HOME="${EMILY_HOME:-$HOME/.emily}"
INSTALL_DIR="${EMILY_INSTALL_DIR:-$EMILY_HOME/emily-agent}"
BIN_DIR="${EMILY_BIN_DIR:-$HOME/.local/bin}"
COMMAND_NAME="${EMILY_COMMAND_NAME:-emily}"
RUN_NPM_INSTALL=true
PRODUCTION_INSTALL=false

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

usage() {
  cat <<EOF
Emily AgentOS installer

Usage:
  install.sh [OPTIONS]

Options:
  --repo URL          Git repository URL (default: \$EMILY_REPO_URL or $REPO_URL)
  --branch NAME      Git branch to install (default: $BRANCH)
  --dir PATH         Repository install directory (default: $INSTALL_DIR)
  --bin-dir PATH     Command link directory (default: $BIN_DIR)
  --name NAME        Command name (default: $COMMAND_NAME)
  --production       Install npm production dependencies only
  --skip-npm         Skip npm install/npm ci
  -h, --help         Show this help

Environment:
  EMILY_REPO_URL, EMILY_BRANCH, EMILY_HOME, EMILY_INSTALL_DIR, EMILY_BIN_DIR,
  EMILY_COMMAND_NAME
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      REPO_URL="${2:?missing value for --repo}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:?missing value for --branch}"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="${2:?missing value for --dir}"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="${2:?missing value for --bin-dir}"
      shift 2
      ;;
    --name)
      COMMAND_NAME="${2:?missing value for --name}"
      shift 2
      ;;
    --production)
      PRODUCTION_INSTALL=true
      shift
      ;;
    --skip-npm)
      RUN_NPM_INSTALL=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

log_info() {
  printf "%b\n" "${CYAN}->${NC} $*"
}

log_success() {
  printf "%b\n" "${GREEN}OK${NC} $*"
}

log_warn() {
  printf "%b\n" "${YELLOW}WARN${NC} $*"
}

log_error() {
  printf "%b\n" "${RED}ERR${NC} $*" >&2
}

fail() {
  log_error "$*"
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

check_node() {
  have node || fail "Node.js >= 22.18 is required. Install Node.js first: https://nodejs.org/"
  if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1);' >/dev/null 2>&1; then
    fail "Node.js >= 22.18 is required; found $(node --version)."
  fi
  log_success "Node $(node --version) found"
}

check_dependencies() {
  have git || fail "git is required. Install git and rerun this script."
  have npm || fail "npm is required. Install Node.js with npm and rerun this script."
  check_node
  log_success "git $(git --version | awk '{print $3}') found"
  log_success "npm $(npm --version) found"
}

install_or_update_repo() {
  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [ -d "$INSTALL_DIR/.git" ]; then
    log_info "Updating existing checkout: $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch origin "$BRANCH"
    if git -C "$INSTALL_DIR" rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
      git -C "$INSTALL_DIR" checkout "$BRANCH"
    else
      git -C "$INSTALL_DIR" checkout -b "$BRANCH" "origin/$BRANCH"
    fi
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
    return
  fi

  if [ -e "$INSTALL_DIR" ]; then
    fail "$INSTALL_DIR exists but is not a git checkout. Choose another --dir or remove it."
  fi

  log_info "Cloning $REPO_URL#$BRANCH into $INSTALL_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
}

install_node_packages() {
  if [ "$RUN_NPM_INSTALL" != true ]; then
    log_warn "Skipping npm install"
    return
  fi

  log_info "Installing Node dependencies"
  if [ -f "$INSTALL_DIR/package-lock.json" ]; then
    if [ "$PRODUCTION_INSTALL" = true ]; then
      npm --prefix "$INSTALL_DIR" ci --omit=dev
    else
      npm --prefix "$INSTALL_DIR" ci
    fi
  else
    if [ "$PRODUCTION_INSTALL" = true ]; then
      npm --prefix "$INSTALL_DIR" install --omit=dev
    else
      npm --prefix "$INSTALL_DIR" install
    fi
  fi
}

write_launcher() {
  mkdir -p "$BIN_DIR"
  local launcher="$BIN_DIR/$COMMAND_NAME"
  local data_dir="$EMILY_HOME/data"
  local role_dir="$INSTALL_DIR/agents"
  local skill_dir="$INSTALL_DIR/skills"

  cat > "$launcher" <<EOF
#!/usr/bin/env bash
set -e

export EMILY_INSTALL_DIR=$(shell_quote "$INSTALL_DIR")
if [ -z "\${EMILY_DATA_DIR:-}" ]; then
  export EMILY_DATA_DIR=$(shell_quote "$data_dir")
fi
if [ -z "\${EMILY_ROLE_DIR:-}" ]; then
  export EMILY_ROLE_DIR=$(shell_quote "$role_dir")
fi
if [ -z "\${EMILY_SKILL_DIR:-}" ]; then
  export EMILY_SKILL_DIR=$(shell_quote "$skill_dir")
fi

exec node $(shell_quote "$INSTALL_DIR/src/index.ts") "\$@"
EOF
  chmod +x "$launcher"
  log_success "Installed command: $launcher"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      log_warn "$BIN_DIR is not on PATH"
      log_warn "Add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
}

print_next_steps() {
  cat <<EOF

${BOLD}Emily AgentOS installed.${NC}

Try:
  $COMMAND_NAME --doctor --deep
  $COMMAND_NAME
  EMILY_WEB_TOKEN=change-me $COMMAND_NAME --web

Data directory:
  $EMILY_HOME/data

Install directory:
  $INSTALL_DIR
EOF
}

main() {
  log_info "Installing Emily AgentOS"
  check_dependencies
  install_or_update_repo
  install_node_packages
  write_launcher
  print_next_steps
}

main "$@"
