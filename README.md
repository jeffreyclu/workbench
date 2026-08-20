# Workbench

A local-first priority queue and shared engineering control plane for Jeffrey, Codex, and Claude.

Workbench is a focused personal TODO list. It combines manually created tasks with Linear issues you explicitly add while keeping private strategy, priority overrides, assignments, and execution history local. The app is a TypeScript/React prototype backed by SQLite.

## Requirements

- Node.js 22.19 or newer
- npm 10 or newer

## Run locally

For daily use, run the promoted snapshot. Agents can then edit this checkout without
hot-reloading partial changes into the Workbench that is controlling them:

```bash
cp .env.example .env
npm install
npm run runtime:promote
npm run runtime:start
```

Open [http://localhost:5173](http://localhost:5173). The stable gateway serves the API
and last-known-good client. It health-checks promoted releases and switches to them
without changing the public port or tunnel.

To inspect agent changes without touching the live control plane, run:

```bash
npm run preview
```

Open [http://localhost:5174](http://localhost:5174). This is a live Vite UI backed by
the stable API and the same SQLite data, so it shows the real queue and conversations.
When the preview is approved, tell Codex or Claude `approve the Workbench preview` in
any conversation. Workbench waits for active agents, builds the release, health-checks
it, and switches `5173` to that immutable release. `npm run dev` remains
available for isolated API development, but it is not the daily control plane.

## Open Workbench on your phone

Two commands, every day:

```bash
npm run runtime:start # stable localhost control plane
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

## Shared MCP API

Codex and Claude can use the same canonical Workbench state through the stateless
Streamable HTTP endpoint at `http://localhost:5173/mcp` (or `/mcp` on the configured
tunnel hostname). Non-loopback clients must send `Authorization: Bearer
<WORKBENCH_TOKEN>`. The endpoint uses the same repository/service boundary as the REST
API; it never reads SQLite directly.

The MCP contract covers tasks, stack order, discoveries, conversations, durable
memories, execution plans, and immutable agent-run results. Mutations are deliberately
narrow:

- Manual tasks and locally owned task fields only; provider-owned fields cannot be set.
- Codex/Claude activity, completed conversation messages, and attributed memories only;
  assistants cannot impersonate Jeffrey or `system`.
- Execution-plan proposals only; approval and child-task creation remain in Workbench.
- Discovery resolution and exact active-stack reordering.

MCP does not expose provider credentials, provider sync, agent dispatch/cancel/retry,
result rewriting, hard delete, or artifact publication. Connect each MCP client to the
same URL and bearer token; `tools/list` is the authoritative machine-readable contract.

### Notes

- Outbound QUIC (UDP 7844) is blocked on the Writer network, so the Cloudflare paths are
  pinned to `--protocol http2`. A tunnel that hangs on startup is usually this.
- Firewall settings cannot be changed from the command line on the managed Mac, and
  Tailscale is deliberately not used here — the phone is not on the Writer tailnet.
- The Slack OAuth flow stays Mac-only: `SLACK_REDIRECT_URI` and `APP_ORIGIN` point at
  `localhost`. Everything else works from the phone.
- `npm run dev:lan` still exists for same-Wi-Fi access on an unmanaged machine, but it
  depends on the inbound firewall being open.

## Publish artifacts for coworkers

Artifact links in agent responses have a **Share** action. It creates a sanitized,
read-only snapshot, deploys the snapshot collection to Cloudflare Pages, and copies a
stable URL. Shared pages contain no Workbench navigation, task data, API access, or
local filesystem paths.

Create a Pages project with a neutral custom domain, then configure:

```dotenv
ARTIFACT_PAGES_PROJECT=workbench-artifacts
ARTIFACT_PUBLIC_BASE_URL=https://artifacts.example.com
# Optional for unattended/server deployments. Local development can use `npx wrangler login`.
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
```

For local development, authenticate once with `npx wrangler login`. For unattended
deployments, configure an API token with Pages deployment access plus the account ID.
Publishing is intentionally unavailable until the project and public URL are configured. The publisher lives behind an adapter so it can
be replaced with Writer-managed hosting later. The current snapshotter supports
standalone Markdown, HTML, and text files; scripts and active content are removed.

### The artifact library

**Artifacts** in the sidebar is the record of everything you have shared. Each entry
keeps its own history:

- **Versions.** Republishing a changed file appends a version. `/<id>/` always serves
  the current one and `/<id>/v2/` keeps that exact snapshot alive, so a link a coworker
  already has never silently changes under them. Older snapshots link forward to the
  latest.
- **History.** Published, republished, revoked, restored, and feedback events, in order.
- **Relationships.** The task and conversation an artifact came from, and you can link
  it to a task after the fact.
- **Republish and revoke.** Republish re-renders from the original file; you do not need
  the path. Revoke takes every version offline and keeps the history. Republishing a
  revoked artifact restores it.

Republishing an unchanged file costs nothing — the content hash is compared before
anything is deployed.

### Feedback from coworkers

Shared pages can carry a small feedback box. It is off by default. Turn it on by
pointing Workbench at its own public hostname:

```dotenv
WORKBENCH_PUBLIC_URL=https://your-name.ngrok-free.app
```

Feedback lands in the artifact library, where you resolve it. Know what you are turning
on before you do:

- `POST /api/artifacts/<id>/comments` answers **without a `WORKBENCH_TOKEN`** — coworkers
  hold no token. Nothing else opens: reading feedback still requires the token, and the
  endpoint accepts writes only for an artifact that exists and is not revoked.
- Submissions are rate limited per artifact (20 per 10 minutes, in memory).
- Both settings must be present. With `WORKBENCH_PUBLIC_URL` empty, published pages carry
  no script and no network access at all, and the endpoint stays gated.

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

Artifact links may resolve files from any sibling repository under the directory that
contains Workbench. Add other trusted directories as a comma-separated
`WORKBENCH_ARTIFACT_ROOTS` value; files elsewhere remain blocked.

## Commands

```bash
npm run dev
npm run dev:lan
npm run share
npm run runtime:promote
npm run runtime:start
npm run preview
npm run typecheck
npm test
npm run lint
npm run build
npm start
```

## Near-term roadmap

1. OAuth-based Linear connection and project selection
2. Additional OAuth source adapters such as GitHub and Gmail
