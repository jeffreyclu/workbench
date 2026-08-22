#!/bin/zsh
set -euo pipefail

label="com.jeffrey.workbench.backup"
plist="$HOME/Library/LaunchAgents/$label.plist"
repo="/Users/jeffrey.lu/dev/workbench"
node="/Users/jeffrey.lu/.nvm/versions/node/v22.19.0/bin/node"
mkdir -p "$HOME/Library/LaunchAgents" "$repo/data/logs"

sed "s|__REPO__|$repo|g; s|__NODE__|$node|g" "$repo/scripts/workbench-backup.plist.template" > "$plist"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Installed Workbench backups every 4 hours: $plist"
