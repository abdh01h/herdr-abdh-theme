#!/bin/sh
# abdh — one-command install for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/abdh01h/herdr-abdh-theme/main/install.sh | sh
#
# Options via environment:
#   HERDR_APP_HOME=/path BRANCH=main NO_LAYOUT=1 sh install.sh
#
# Downloads the repository archive, backs up what it replaces, installs the
# theme, layout and mods, merges the editor keys (python3/node if present),
# runs `herdr-app check` for every mod, and switches layout when a window runs.
# Nothing outside the Herdr home is touched.

set -eu

REPO="${REPO:-abdh01h/herdr-abdh-theme}"
BRANCH="${BRANCH:-main}"
HOME_DIR="${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/abdh-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

backup() {
  [ -e "$1" ] || return 0
  cp -R "$1" "$1.bak-$STAMP"
  BACKUPS="$BACKUPS $(basename "$1").bak-$STAMP"
}
BACKUPS=""

echo "==> abdh: downloading $REPO@$BRANCH"
URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP/theme.tgz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP/theme.tgz" "$URL"
else
  echo "abdh: need curl or wget" >&2
  exit 1
fi

tar -xzf "$TMP/theme.tgz" -C "$TMP"
ROOT="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
[ -n "$ROOT" ] || { echo "abdh: archive had no repository folder" >&2; exit 1; }

mkdir -p "$HOME_DIR/themes" "$HOME_DIR/layouts" "$HOME_DIR/mods"
echo "==> abdh: installing into $HOME_DIR"

for file in themes/abdh.json layouts/abdh.json layouts/abdh.svg; do
  [ -f "$ROOT/$file" ] || continue
  backup "$HOME_DIR/$file"
  cp "$ROOT/$file" "$HOME_DIR/$file"
done

for dir in "$ROOT"/mods/abdh-*; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  case "$name" in *.bak-*) continue ;; esac
  backup "$HOME_DIR/mods/$name"
  rm -rf "$HOME_DIR/mods/$name"
  cp -R "$dir" "$HOME_DIR/mods/$name"
done

KEYS="$HOME_DIR/keys.json"
SNIPPET="$ROOT/keys.snippet.json"
if [ -f "$SNIPPET" ]; then
  backup "$KEYS"
  if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
    PY="$(command -v python3 || command -v python)"
    "$PY" - "$KEYS" "$SNIPPET" <<'PYEOF'
import json, os, sys
keys_path, snippet_path = sys.argv[1], sys.argv[2]
snippet = json.load(open(snippet_path, encoding="utf-8"))
keys = {}
if os.path.exists(keys_path):
    try:
        keys = json.load(open(keys_path, encoding="utf-8"))
    except Exception:
        print("abdh: keys.json is not valid JSON; left it untouched", file=sys.stderr)
        raise SystemExit(0)
for section, bindings in snippet.items():
    target = keys.setdefault(section, {})
    if not isinstance(target, dict):
        target = keys[section] = {}
    for chord, action in bindings.items():
        target.setdefault(chord, action)
with open(keys_path, "w", encoding="utf-8") as out:
    json.dump(keys, out, indent=2, ensure_ascii=False)
    out.write("\n")
PYEOF
  elif command -v node >/dev/null 2>&1; then
    node - "$KEYS" "$SNIPPET" <<'JSEOF'
const fs = require("fs");
const [keysPath, snippetPath] = process.argv.slice(2);
const snippet = JSON.parse(fs.readFileSync(snippetPath, "utf8"));
let keys = {};
if (fs.existsSync(keysPath)) {
  try { keys = JSON.parse(fs.readFileSync(keysPath, "utf8")); }
  catch { console.error("abdh: keys.json is not valid JSON; left it untouched"); process.exit(0); }
}
for (const [section, bindings] of Object.entries(snippet)) {
  if (!keys[section] || typeof keys[section] !== "object") keys[section] = {};
  for (const [chord, action] of Object.entries(bindings)) if (!(chord in keys[section])) keys[section][chord] = action;
}
fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n");
JSEOF
  else
    echo "    keys.json not merged (no python3/node); add mod:abdh-editor from keys.snippet.json by hand"
  fi
fi

if command -v herdr-app >/dev/null 2>&1; then
  if [ -d "$HOME_DIR/mods/workspace-chrome" ]; then
  echo "==> abdh: checking mods"
  failed=0
  for mod in "$HOME_DIR"/mods/abdh-*; do
    [ -d "$mod" ] || continue
    case "$(basename "$mod")" in *.bak-*) continue ;; esac
    if ! herdr-app check "$mod" >/dev/null 2>&1; then
      echo "    check failed: $(basename "$mod")" >&2
      failed=$((failed + 1))
    fi
  done
  [ "$failed" -eq 0 ] && echo "    all abdh mods pass"
  else
    echo "==> abdh: start Herdr once (it installs its shipped mods), then: herdr-app check <each abdh mod>"
  fi

  if [ "${NO_LAYOUT:-0}" != "1" ]; then
    if herdr-app do layout.switch --name abdh >/dev/null 2>&1; then
      echo "==> abdh: layout switched"
    else
      echo "==> abdh: open Herdr and run: herdr-app do layout.switch --name abdh"
    fi
  fi
else
  echo "==> abdh: herdr-app not found; open Herdr and run: herdr-app do layout.switch --name abdh"
fi

[ -n "$BACKUPS" ] && echo "==> abdh: backups:$BACKUPS"
echo "==> abdh: done. Settings: $HOME_DIR/abdh-settings.json (open abdh settings in the sidebar footer)."
