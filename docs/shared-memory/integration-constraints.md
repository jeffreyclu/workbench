## Integration constraints

### One integration mechanism no tunnels

*Any Workbench integration must use one mechanism that works in both Claude and Codex and must not depend on a public tunnel IT can block*

Jeffrey rejected the pattern where each external integration in Workbench connects a
different way. His standing requirement is a **single holistic mechanism** for all of them,
not a per-provider special case. When proposing how to wire up Figma, Atlassian, Linear, or
any future source, converge on one path rather than solving each provider on its own terms.

Two hard constraints go with it:

1. **Both Claude and Codex must be able to use it inside Workbench.** A solution that only
   authenticates Codex agents (or only Claude) does not count as solved. Jeffrey runs both
   and does not want to configure things twice or remember which assistant has which access.
2. **It must not depend on anything his IT department can block.** His IT admin blocked the
   ngrok domain, which permanently killed Workbench's own remote-MCP OAuth broker — that
   broker builds its redirect URI from `APP_API_ORIGIN` and needs a publicly reachable HTTPS
   host. Do not propose replacing ngrok with another public tunnel (Cloudflare Tunnel,
   localtunnel, a hosted relay); assume the same policy would catch it. Prefer transports
   that stay on the vendor's own HTTPS domain plus a `127.0.0.1` loopback OAuth callback,
   since nothing leaves the machine and the domains are ones Writer already trusts.

The general lesson: when Jeffrey asks for an integration, the deliverable is one uniform
path with no tunnel dependency and no assistant-specific gap, not a working demo for a
single provider in a single client.

#### Figma and Atlassian MCP authentication is Workbench-owned (2026-08-29)

Workbench must not treat a Codex subprocess as the credential broker for Figma or Atlassian.
That path failed even while the same provider tools worked in the active Codex session, and
generic “connector unavailable” search errors were surfaced as expired authorization. Jeffrey
then had to reconnect both sources repeatedly on Aug 27, Aug 28, and Aug 29.

The supported shape is one Workbench-owned remote MCP OAuth connection per provider. Agents never
need or own a separate Figma or Atlassian connection. OAuth
returns to the stable local Workbench port through `127.0.0.1`, with no public tunnel. Workbench
persists access-token and refresh-token rotation from the MCP SDK so restarts do not restore stale
credentials. Codex and Claude consume the resulting source context through Workbench rather than
maintaining separate provider logins. Only a verified OAuth error may move a source to
`reauth_required`; an ordinary search or connector failure keeps the source connected but unhealthy
and retries through normal background scanning.

Workbench's MCP surface exposes `search_external_sources` and `resolve_external_source` so dispatched
agents can make read-only external calls through those same Workbench-owned connections when prompt
prefetching is insufficient. These tools are open-world but read-only: credentials remain server-side,
results are normalized by the connection broker, and no external mutation capability is implied.

### No personal phone on corporate tailnet

*Jeffrey will not enroll his personal phone in the Writer corporate Tailscale tailnet, so mobile access to local dev servers must use a transport that requires nothing installed on the phone.*

When the question is "how do I reach a local dev server from my phone," do not propose
`tailscale serve` or any solution that requires Jeffrey's phone to join the Writer
corporate tailnet. He declined this directly on 2026-08-19. The Writer tailnet carries
hundreds of company devices including production infrastructure, and he does not want his
personal phone enrolled in it — this is about the device boundary, not about Tailscale's
technical merits.

This matters because the obvious alternatives are also constrained: his work Mac is
Kandji-managed and its application firewall blocks inbound connections to `node`, which
cannot be changed from the command line, so plain LAN access does not work either. The
remaining shape that satisfies both constraints is an outbound tunnel that terminates at a
public URL the phone can open in a normal browser (`cloudflared`, `ngrok`, or Tailscale
Funnel, which unlike `serve` does not require the client to be on the tailnet).

Because that shape is publicly reachable, propose adding an authentication gate to the
service before, or in the same change as, exposing it — Workbench in particular has no
inbound auth of any kind.

### No new slack apps

*Jeffrey cannot create Slack apps in Writer's workspace, so any Slack integration must avoid client IDs, bot tokens, and incoming webhooks.*

Jeffrey stated plainly that creating a new Slack app is "a no go" in Writer's
enterprise-managed Slack workspace. Treat this as a hard constraint rather than a
slow approval path: do not propose designs whose first step is "create an app at
api.slack.com/apps", and do not propose anything downstream of that step either —
bot tokens (`xoxb-`), classic incoming webhooks (`hooks.slack.com/services/...`),
and OAuth client ID/secret pairs all require an app to exist first.

This constraint also rules out the hosted Slack MCP server at `https://mcp.slack.com/mcp`,
which is easy to mistake for an escape hatch. Its authorization-server metadata exposes
no `registration_endpoint`, so it does not support OAuth Dynamic Client Registration;
every client must bring a pre-registered `client_id` and `client_secret`, which is a
Slack app by another name.

The remaining option that needs no app is a Slack Workflow Builder webhook trigger
(`https://hooks.slack.com/triggers/...`), which a regular member can create from the
Slack UI. Prefer that shape, or an inbound-from-Slack design that piggybacks on tooling
Writer has already installed.

### Writer PR preview login is basic auth, not SSO

*Writer's `writer-app-pr-<N>.dev-deer.qordobadev.com` PR previews sit behind an HTTP basic-auth
gate in front of the app's own login page — SSO and "sign in with Google" on the preview's login
screen are not the credential to use for that outer gate.*

When Jeffrey or an agent opens a PR preview created by the `preview` label, the flow is two
separate logins stacked, not one:

1. **Outer gate: HTTP basic auth.** Credentials are in 1Password → Office vault →
   "Basic Auth Dev." This prompt is unrelated to Writer's own auth system, so SSO/Gmail
   buttons on it (if any render) do nothing useful.
2. **Inner gate: the Writer App login page itself**, reached only after basic auth succeeds.
   Per a 2026-08-03 helpdesk response, this may also require Tailscale connected to the
   `qordoba-devel-gcoo` exit node first, and the account to use on that page is a specific
   shared dev account ("select May's account"), not Jeffrey's personal SSO/Google identity.

A known failure mode at the basic-auth prompt: 1Password's autofill can trigger a recursive
redirect loop back to the same login dialog. Work around it by opening the preview in an
incognito window and typing/pasting the basic-auth credentials manually instead of using
1Password autofill.

Source: Slack threads in `#CSJ8VQSVC` (2026-08-06), `#C080MJCFC1E` (2025-03-20), and
`#C05G3DFK58X` (2026-08-03); Confluence "Preview Environments [Deprecated]" and
"skynet-preview to PR-preview: migration and setup".

### Check for a local `gh` CLI before claiming no GitHub access

*An agent's session may lack a GitHub MCP tool while still having a fully authenticated `gh` CLI
available in its Bash shell — check `which gh && gh auth status` before telling Jeffrey GitHub
access is unavailable.*

On 2026-08-24 an agent claimed it had "no GitHub access" to inspect a PR diff, reasoning only from
the fact that the `atlassian` MCP server (Confluence/Slack) was unauthorized in that session and
generalizing that gap to GitHub as well. Jeffrey pointed out Workbench's GitHub source showed
"CONNECTED." Two separate things turned out to be true: (1) the Workbench GitHub source connector
is real but narrow — it only backs `resolve_links`/`search` for pulling link context into prompts,
not full repo/PR reads, so its "CONNECTED" state was not actually the answer either; (2) the local
shell had `gh` already authenticated (`gh auth status` showed a logged-in `repo`-scoped token), and
`gh pr view <N> --repo <org>/<repo> --json ...` worked immediately once tried.

The general lesson: before reporting a capability gap, check the concrete local tool (`gh`, `docker`,
language CLIs, etc.) directly rather than inferring its absence from an unrelated MCP server's auth
state. MCP-server authorization and locally-installed authenticated CLIs are independent — one being
unauthorized says nothing about the other.

### Provider account profiles are isolated and provider-neutral

Jeffrey has separate Claude and GPT accounts and requires an account-switching mechanism that works
for both providers while preserving shared Workbench context and identical run budgets. The runner
now supports provider-specific credential directories through `WORKBENCH_CLAUDE_ACCOUNT_<NAME>_DIR`
(`CLAUDE_CONFIG_DIR`) and `WORKBENCH_CODEX_ACCOUNT_<NAME>_DIR` (`CODEX_HOME`), selected by the
corresponding `WORKBENCH_CLAUDE_ACCOUNT` or `WORKBENCH_CODEX_ACCOUNT` value. Unknown profiles fail
closed; `default` retains the normal CLI credentials. This is the subprocess foundation for a UI
account picker; credentials are never placed in prompts or shared memory.

Task dispatches now persist the selected profile name on the individual `agent_runs` row and pass it
to the spawned provider CLI. The Workbench task execution panel keeps the chosen profile per task in
browser storage, so Jeffrey can type `personal` (or another configured name) for that dispatch without
changing the Workbench process environment. The stored profile name is audit metadata only.

As of 2026-08-24, account setup is a first-class Workbench control: managed named profiles live under
`~/.workbench/agent-accounts/<provider>/<profile>`, and the task execution panel opens the installed
provider CLI login in Terminal. Codex runs `codex login`; Claude runs `claude auth login --claudeai`.
Their normal browser windows handle Google sign-in, so Workbench never sees, stores, or copies a token.

As of 2026-08-24, the named `personal` profile is the default only for Workbench and Pluto tasks,
identified by their canonical project names or workspaces (`workbench` and `Pluto-Alpha`). All other
tasks default to the provider CLI's `default` credentials. The service resolves an omitted profile from
the task itself; an explicit named profile always wins, and historical runs retain their recorded profile
for auditability. Do not turn this project-scoped rule into a global profile default.

The shared room must not silently pin an existing conversation to that task default. Its composer exposes
the same account-profile selector as task execution; every dispatched turn records the selected profile,
and that explicit choice wins over the project/unlinked fallback. Reopening a conversation restores the
most recent recorded profile so Jeffrey can see and change the next turn's account before sending it.

*Correction from Jeffrey, 2026-08-24.* A genuinely new shared conversation always starts on the provider
CLI's `default` profile — never the named `personal` profile, including in the Workbench project. This is
separate from task dispatch's project-scoped fallback and from an existing conversation restoring its last
recorded profile.
