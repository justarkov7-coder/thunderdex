#!/bin/sh
# Installs the Thunderdex background service (macOS, per-user) and builds the add-on.
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${TBMCP_PYTHON:-$HOME/.local/share/thunderbird-mcp/.venv/bin/python}"
[ -x "$PYTHON" ] || { echo "thunderbird-mcp virtualenv not found: set TBMCP_PYTHON"; exit 1; }
command -v codex >/dev/null || { echo "Codex CLI not found (npm i -g @openai/codex)"; exit 1; }
mkdir -p "$HOME/.local/state/thunderdex" "$HOME/.config/thunderdex"
chmod 700 "$HOME/.local/state/thunderdex"
[ -f "$HOME/.config/thunderdex/config.json" ] || cp "$ROOT/config/config.example.json" "$HOME/.config/thunderdex/config.json"
PLIST="$HOME/Library/LaunchAgents/dev.thunderdex.service.plist"
sed -e "s#@PYTHON@#$PYTHON#" -e "s#@ROOT@#$ROOT#g" -e "s#@HOME@#$HOME#" "$ROOT/launchd/dev.thunderdex.service.plist.in" > "$PLIST"
launchctl bootout "gui/$(id -u)/dev.thunderdex.service" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
python3 "$ROOT/addon/build.py"
echo "Service running. Edit ~/.config/thunderdex/config.json, then install dist/thunderdex.xpi"
echo "in Thunderbird (Add-ons Manager > gear > Install Add-on From File)."
