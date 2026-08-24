#!/bin/zsh
set -euo pipefail

label="com.jeffrey.workbench.runtime"
plist="$HOME/Library/LaunchAgents/$label.plist"
repo="/Users/jeffrey.lu/dev/workbench"
node="/Users/jeffrey.lu/.nvm/versions/node/v22.19.0/bin/node"
node_dir="${node:h}"
agent_bin_dir="/Users/jeffrey.lu/.local/bin"
runtime_port=$(sed -n 's/^WORKBENCH_RUNTIME_PORT=//p' "$repo/.env" | head -1)
runtime_port=${runtime_port:-5173}

mkdir -p "$HOME/Library/LaunchAgents" "$repo/data/logs"
sed "s|__REPO__|$repo|g; s|__AGENT_BIN_DIR__|$agent_bin_dir|g; s|__NODE_DIR__|$node_dir|g; s|__NODE__|$node|g; s|__WORKBENCH_RUNTIME_PORT__|$runtime_port|g" "$repo/scripts/workbench-runtime.plist.template" > "$plist"
launchctl unload "$plist" 2>/dev/null || true
launchctl load -w "$plist"
echo "Installed persistent Workbench runtime supervisor: $plist"
