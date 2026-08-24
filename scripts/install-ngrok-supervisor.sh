#!/bin/zsh
set -euo pipefail
label="com.jeffrey.workbench.ngrok"
plist="$HOME/Library/LaunchAgents/$label.plist"
watchdog_label="com.jeffrey.workbench.ngrok-watchdog"
watchdog_plist="$HOME/Library/LaunchAgents/$watchdog_label.plist"
repo="/Users/jeffrey.lu/dev/workbench"
domain=$(sed -n 's/^NGROK_DOMAIN=//p' "$repo/.env" | head -1)
runtime_port=$(sed -n 's/^WORKBENCH_RUNTIME_PORT=//p' "$repo/.env" | head -1)
runtime_port=${runtime_port:-5173}
if [[ -z "$domain" ]]; then
  echo "NGROK_DOMAIN is required in $repo/.env" >&2
  exit 1
fi
mkdir -p "$HOME/Library/LaunchAgents" "$repo/data/logs"
sed "s|__REPO__|$repo|g; s|__NGROK_DOMAIN__|$domain|g; s|__WORKBENCH_RUNTIME_PORT__|$runtime_port|g" "$repo/scripts/workbench-ngrok.plist.template" > "$plist"
launchctl unload "$plist" 2>/dev/null || true
launchctl load -w "$plist"
sed "s|__REPO__|$repo|g; s|__NGROK_DOMAIN__|$domain|g" "$repo/scripts/workbench-ngrok-watchdog.plist.template" > "$watchdog_plist"
launchctl unload "$watchdog_plist" 2>/dev/null || true
launchctl load -w "$watchdog_plist"
echo "Installed persistent Workbench ngrok tunnel: $plist"
