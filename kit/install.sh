#!/usr/bin/env bash
# LLM Bus adherence kit installer. Idempotent - safe to re-run.
#
# What it does:
#   1. Finds the repo root (must contain a .git directory).
#   2. Installs the git pre-commit hook (copies pre-commit + reconcile-hook.mjs into
#      .git/hooks and marks them executable).
#   3. Seeds ./llm-bus.config.json from the example IF one does not already exist.
#   4. With --with-okf: seeds a structure-only OKF knowledge-wiki starter into docs/wiki/
#      (never clobbers existing files). The wiki is knowledge; the bus is coordination.
#   5. Prints where the paste-ready CLAUDE.md block lives.
set -euo pipefail

WITH_OKF=0
for arg in "$@"; do
  case "$arg" in
    --with-okf) WITH_OKF=1 ;;
    *) echo "[llm-bus] unknown argument: $arg" >&2; exit 2 ;;
  esac
done

KIT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

# Locate the .git directory by walking up from the current working directory.
find_repo_root() {
  local dir
  dir="$(pwd)"
  while [ "$dir" != "/" ]; do
    if [ -d "$dir/.git" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

REPO_ROOT="$(find_repo_root || true)"
if [ -z "${REPO_ROOT:-}" ]; then
  echo "[llm-bus] no .git directory found from $(pwd); run this from inside a git repo." >&2
  exit 1
fi
echo "[llm-bus] repo root: $REPO_ROOT"

HOOKS_DIR="$REPO_ROOT/.git/hooks"
mkdir -p "$HOOKS_DIR"

# 1. git pre-commit hook + its reconcile script, side by side so the shim can find it.
cp "$KIT_DIR/pre-commit" "$HOOKS_DIR/pre-commit"
cp "$KIT_DIR/reconcile-hook.mjs" "$HOOKS_DIR/reconcile-hook.mjs"
chmod +x "$HOOKS_DIR/pre-commit"
echo "[llm-bus] installed pre-commit hook -> $HOOKS_DIR/pre-commit"

# 2. seed config if absent (never clobber an existing one).
CONFIG_DEST="$REPO_ROOT/llm-bus.config.json"
if [ -f "$CONFIG_DEST" ]; then
  echo "[llm-bus] config already present, leaving it untouched: $CONFIG_DEST"
else
  cp "$KIT_DIR/llm-bus.config.json.example" "$CONFIG_DEST"
  echo "[llm-bus] seeded config -> $CONFIG_DEST (edit endpoint/tokenEnv/sequences)"
fi

# 3. optional OKF wiki starter (structure only; never clobber). The bus never stores knowledge -
#    this seeds files into the consuming repo's git, where the wiki lives.
if [ "$WITH_OKF" = "1" ]; then
  OKF_DEST="$REPO_ROOT/docs/wiki"
  mkdir -p "$OKF_DEST"
  for f in index.md log.md overview.md README.md; do
    if [ -f "$OKF_DEST/$f" ]; then
      echo "[llm-bus] okf: $OKF_DEST/$f exists, leaving it untouched"
    else
      cp "$KIT_DIR/okf/$f" "$OKF_DEST/$f"
      echo "[llm-bus] okf: seeded $OKF_DEST/$f"
    fi
  done
  echo "[llm-bus] okf: starter wiki in docs/wiki/ (platform repos: move it to wiki/)."
  echo "[llm-bus] okf: verify reserved names/fields against github.com/GoogleCloudPlatform/knowledge-catalog (okf/SPEC.md)."
fi

# 4. point the operator at the CLAUDE.md block.
echo ""
echo "[llm-bus] NEXT: paste the Planning-Gate block into your repo's CLAUDE.md."
echo "[llm-bus]       block file: $KIT_DIR/CLAUDE.md.block.md"
echo "[llm-bus]       set the bearer token in your environment, e.g.:"
echo "[llm-bus]         export LLM_BUS_TOKEN=...   # name must match tokenEnv in the config"
echo "[llm-bus] done."
