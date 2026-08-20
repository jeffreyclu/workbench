#!/bin/zsh
set -euo pipefail

label="com.jeffrey.workbench.discovery"
plist="$HOME/Library/LaunchAgents/$label.plist"
repo="/Users/jeffrey.lu/dev/workbench"
node="/Users/jeffrey.lu/.nvm/versions/node/v22.19.0/bin/node"
mkdir -p "$HOME/Library/LaunchAgents" "$repo/data/logs"

sed "s|__REPO__|$repo|g; s|__NODE__|$node|g" "$repo/scripts/workbench-discovery.plist.template" > "$plist"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Installed nightly Workbench discovery at 5:00 AM local time: $plist"
