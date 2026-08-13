#!/bin/sh
# Forge CLI installer. Touches only ~/.forge/src and ~/.local/bin/forge.
# Requires: git, Node 22+, pnpm (or corepack).
set -eu

SERVER_URL="__FORGE_SERVER__"
SRC="$HOME/.forge/src"
BIN_DIR="$HOME/.local/bin"

say() { printf '%s\n' "$*"; }
fail() { printf 'forge install: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is required"
command -v node >/dev/null 2>&1 || fail "Node 22+ is required (https://nodejs.org)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || fail "Node 22+ required, found $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  command -v corepack >/dev/null 2>&1 || fail "pnpm is required (npm i -g pnpm)"
  say "enabling pnpm via corepack"
  corepack enable >/dev/null 2>&1 || fail "could not enable pnpm; install it with: npm i -g pnpm"
fi

if [ -d "$SRC/.git" ]; then
  say "updating forge in $SRC"
  git -C "$SRC" pull --ff-only
else
  say "cloning forge into $SRC"
  mkdir -p "$HOME/.forge"
  git clone --depth 1 https://github.com/rocketman3881/forge.git "$SRC"
fi

say "building the CLI"
cd "$SRC"
pnpm install --frozen-lockfile >/dev/null
pnpm --filter forge-cli build >/dev/null

mkdir -p "$BIN_DIR"
ln -sf "$SRC/packages/cli/dist/cli.js" "$BIN_DIR/forge"
chmod +x "$SRC/packages/cli/dist/cli.js"

# Point the CLI at this server unless the user already configured one.
CONFIG="$HOME/.forge/config.json"
if [ ! -f "$CONFIG" ]; then
  printf '{\n  "serverUrl": "%s"\n}\n' "$SERVER_URL" > "$CONFIG"
fi

say ""
say "forge installed to $BIN_DIR/forge"
case ":$PATH:" in
  *:"$BIN_DIR":*) ;;
  *)
    say "add it to your PATH, e.g.:"
    say "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zprofile && exec \$SHELL"
    ;;
esac
say "next: forge login"
