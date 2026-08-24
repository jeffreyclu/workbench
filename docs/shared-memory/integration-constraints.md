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

