#!/usr/bin/env bash
# Build the VS Code extension (.vsix) and install it into VS Code.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f package.json ]; then
    echo "package.json not found next to this script." >&2
    exit 1
fi

if ! command -v code &> /dev/null; then
    echo "'code' (VS Code CLI) could not be found on PATH." >&2
    exit 1
fi

# Prefer a globally installed vsce, otherwise fall back to npx.
if command -v vsce &> /dev/null; then
    VSCE=(vsce)
else
    VSCE=(npx --yes @vscode/vsce)
fi

VSIX="$(node -p "const p=require('./package.json'); p.name + '-' + p.version").vsix"

if [ ! -d node_modules ]; then
    echo "Installing dependencies..."
    npm ci
fi

echo "Building $VSIX..."
# `vsce package` runs the vscode:prepublish script (npm run compile).
"${VSCE[@]}" package --out "$VSIX"

echo "Installing $VSIX..."
code --install-extension "$VSIX" --force

echo "Built and installed $VSIX. Reload VS Code windows to pick it up."
