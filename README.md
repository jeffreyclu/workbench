# Workbench

A local-first priority queue and shared engineering control plane for Jeffrey, Codex, and Claude.

Workbench is a focused personal TODO list. It combines manually created tasks with Linear issues you explicitly add while keeping private strategy, priority overrides, assignments, and execution history local. The app is a TypeScript/React prototype backed by SQLite.

## Requirements

- Node.js 22.19 or newer
- npm 10 or newer

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The API runs on port `4317` and Vite proxies `/api` requests to it.

## Open Workbench on your phone

Two commands, every day:

```bash
npm run dev      # localhost only, as usual
npm run share    # publishes it and prints the link
```

`share` opens an **outbound** tunnel, so the managed-Mac inbound firewall never sees it
and nothing needs to be installed on the phone. The first visit on a new device needs
the printed `?token=` link once; that sets a one-year cookie and the bare URL works
afterwards. Ctrl-C takes the tunnel down.

### Give it a stable hostname (do this once)

The auth cookie is scoped to the hostname, so with a random hostname you have to
re-open the `?token=` link every single time. For daily use, pin one:

```bash
brew install ngrok
ngrok config add-authtoken <token>   # free account at dashboard.ngrok.com
```

Claim the free static domain on the ngrok dashboard, then put it in `.env`:

```dotenv
NGROK_DOMAIN=your-name.ngrok-free.app
```

`npm run share` picks it up automatically. Bookmark `https://your-name.ngrok-free.app`
on the phone and it just works from then on.

If you would rather stay on Cloudflare and own a domain there, set `TUNNEL_HOSTNAME`
instead and create a named tunnel called `workbench`
(`cloudflared tunnel create workbench` + `cloudflared tunnel route dns workbench <host>`).
With neither variable set, `share` falls back to a Cloudflare quick tunnel with a
random hostname — fine for one-off use.

### Security

Every inbound request is gated by `WORKBENCH_TOKEN` (`src/server/auth.ts`), enforced on
both the API and the Vite dev server. Requests from loopback are exempt so local work is
unaffected. `/api/health` stays open so the tunnel can health-check.

The token is a full-access credential: anyone holding the `?token=` link gets read/write
on the queue and strategy notes and can trigger agent runs. Treat it like a password.
Rotate by deleting `WORKBENCH_TOKEN` from `.env` and re-running `npm run share`.

### Notes

- Outbound QUIC (UDP 7844) is blocked on the Writer network, so the Cloudflare paths are
  pinned to `--protocol http2`. A tunnel that hangs on startup is usually this.
- Firewall settings cannot be changed from the command line on the managed Mac, and
  Tailscale is deliberately not used here — the phone is not on the Writer tailnet.
- The Slack OAuth flow stays Mac-only: `SLACK_REDIRECT_URI` and `APP_ORIGIN` point at
  `localhost`. Everything else works from the phone.
- `npm run dev:lan` still exists for same-Wi-Fi access on an unmanaged machine, but it
  depends on the inbound firewall being open.

## Configure Linear

Create a Linear personal API key and add it to `.env`:

```dotenv
LINEAR_API_KEY=lin_api_...
```

Use Sources in the sidebar to select a team and optionally narrow it to particular projects. The refresh button updates a hidden searchable catalog; it does not add issues to your queue. Use New → From Linear to search that catalog or paste a Linear issue URL, then explicitly add the issue to your TODO list. Linear synchronization is read-only in this prototype.

## Configure Slack

Slack connects in two independent directions. Either can be used without the other.

### Inbound: Slack → Workbench (read)

Workbench connects to Slack's hosted MCP server through OAuth; you do not paste a Slack token into the browser. Create an internal Slack app, add `http://localhost:4317/api/source-connections/slack/oauth/callback` as an OAuth redirect URL, and grant the user-token scopes `search:read.public`, `search:read.private`, `search:read.mpim`, and `search:read.im`. Then add `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` to `.env`.

Restart Workbench and choose Sources → Slack → Connect Slack. Slack currently requires workspace-admin approval for hosted MCP access. Plan my day will then search the last day of messages directed to you and feed that context into the queue proposal.

### Outbound: Workbench → Slack (notifications)

Workbench posts a Slack message when an agent run finishes or fails, so a long run does not
need watching. This is off until configured, and uses outbound HTTPS only — no inbound
callback, tunnel, or firewall change is involved.

Pick one delivery mode in `.env`:

```dotenv
# Mode A — bot token. Scope chat:write, and invite the bot to the channel.
SLACK_BOT_TOKEN=xoxb-...
SLACK_NOTIFY_CHANNEL=#workbench

# Mode B — incoming webhook, bound to one channel by Slack.
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

A bot token plus `SLACK_NOTIFY_CHANNEL` takes precedence, because it is the only mode that can
choose a destination at send time. `SLACK_BOT_TOKEN` is also used to expand pasted Slack
permalinks into task drafts.

Check status and send a test message (add `Authorization: Bearer $WORKBENCH_TOKEN` if a token is set):

```bash
curl localhost:4317/api/integrations/slack
curl -X POST localhost:4317/api/integrations/slack/test
```

Delivery retries rate limits and transient server errors, honouring Slack's `Retry-After`. A
Slack outage is never allowed to fail or delay the agent run that triggered the notification.

Note: Slack blocks programmatic posting to some externally-shared channels. If a send is
rejected with `channel_not_found` or similar, try a channel your workspace owns.

## Data ownership

Provider sync owns:

- Linear title and description
- Linear workflow status
- Linear project, labels, URL, and due date

Workbench owns:

- Queue priority and ordering
- Strategy
- Codex, Claude, and Jeffrey assignments
- Activity and handoff notes
- All manual tasks

The SQLite database is stored at `data/workbench.db` by default and is ignored by Git.

## Commands

```bash
npm run dev
npm run dev:lan
npm run share
npm run typecheck
npm test
npm run lint
npm run build
npm start
```

## Near-term roadmap

1. OAuth-based Linear connection and project selection
2. MCP server exposing the shared work-item API to Codex and Claude
3. Additional OAuth source adapters such as GitHub and Gmail
