#!/bin/zsh
set -euo pipefail
label="com.jeffrey.workbench.ngrok"
# This supervisor owns ingress only. A Workbench 5xx means the application is
# unhealthy, not that ngrok needs to be torn down and recreated. Restarting the
# tunnel in that state causes ERR_NGROK_334/3200 flapping and hides the real fault.
if curl -fsS --max-time 3 http://127.0.0.1:4040/api/tunnels \
  | grep -q '"public_url"'; then
  exit 0
fi
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') ngrok endpoint is absent; restarting $label" >&2
launchctl kickstart -k "$label" 2>/dev/null || {
  launchctl stop "$label" 2>/dev/null || true
  launchctl start "$label"
}
