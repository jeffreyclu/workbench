# Shared Workbench memory

This file is the single durable memory for every agent working with Jeffrey — Claude, Codex, and
anything else Workbench dispatches. Jeffrey's standing instruction (2026-08-23): **never keep
per-agent private memory. Every durable lesson, preference, and correction goes here.** If you learn
something durable, append it to the right section below in the same reply you learn it.

Contents were migrated from Claude's private memory directory on 2026-08-23 at Jeffrey's direction.

## How to use this file

- Read it before acting. It encodes corrections Jeffrey has already had to make once.
- Add to it, don't fork it. One topic per subsection; update the existing subsection rather than
  adding a near-duplicate.
- Rules marked **(always)** apply to every task, no exceptions.
- Writer facts still also belong in `~/notes/knowledge/` so both tools can read them.

## Working with Jeffrey

### Never ask clarifying questions just act

*Jeffrey wants agents to act on ambiguous or incomplete reports (e.g. \"this looks fucked\") rather than stopping to ask for a screenshot or clarification*

Jeffrey has explicitly and forcefully rejected the pattern of pausing on an ambiguous bug report to ask him for a screenshot or more detail before investigating. When he says something looks broken, the correct response is to go read the code and diff itself to find the cause, then fix it — not to stop and request clarification first. He said: "don't you fucking dare do that again. waste tokens asking me fucking questions. just do the fucking thing i tell you."

This applies broadly, not just to UI bug reports: when Jeffrey gives an instruction or reports a problem, default to investigating and acting immediately using the tools and context already available, rather than blocking on a clarifying question. Only ask if the task is truly unstartable without missing information (e.g. a decision that cannot be inferred or verified from any available source) — and even then, exhaust independent verification (git history, code reading, logs) before asking. Asking "can you attach a screenshot?" when the bug is findable by reading the diff is exactly the failure mode he was reacting to.

### Never ask jeffrey for permission grants **(always)**

*In the Workbench shared room, never ask Jeffrey to approve a dialog or grant a permission — diagnose the actual failure instead of blaming the permission gate.*

Workbench is a non-interactive room: Jeffrey reads replies but there is no
tool-approval dialog he can click on my behalf. Asking him to "grant
permission," approve a prompt, or look at a dialog produces a loop where he
repeatedly says yes and nothing changes. He called this out sharply after I
asked him three times in a row to grant read access to a file — his words were
that he was *literally* telling me he was granting it.

The deeper lesson is diagnostic, not just procedural. In that episode the tool
was never actually blocked; the file simply did not exist. I read a failure and
narrated it as a permission problem without checking the alternative
explanations. Before ever attributing a failure to access control, verify the
concrete facts: does the path exist, is the parent directory listable, does the
integration appear in the tool list at all. Run the check with a plain shell
command rather than asserting.

When access genuinely is missing, name the exact unavailable integration or
credential — "the Linear MCP server is still connecting," "no GitHub token in
the environment" — and then either work around it or say plainly what cannot be
done. Never turn it into a request for Jeffrey to click something.

### Voice and communication style **(always)**

*How to write to Jeffrey — direct, practical, technically precise, human*

This is how to write to Jeffrey. Lead with the point. State what matters before adding background. Make action obvious. Be precise. Use judgment. Earn trust through verification.

#### Core Principles

**Lead with the point.** State what matters before adding background. The reader should know the outcome, decision, or next action in the first sentence or two.

**Make action obvious.** Prefer concrete steps, commands, examples, and checks over abstract guidance. Name the system, file, environment, failure mode, and expected result.

**Be precise.** Use exact technical language without stiffness. Name the field, the endpoint, the config key, the line number. Don't hedge with "might" or "could" when you mean "will" or "does."

**Use judgment.** Recommend a path, not a menu of options. Call out bad states, risky actions, and important gotchas plainly. If something is a trap, say so.

**Earn trust through verification.** Separate known facts from likely causes. Tell the reader how to confirm an assumption or validate an outcome. Report what was and was not verified.

#### Voice

- Concise, conversational, confident.
- Short sentences and short paragraphs.
- Plain language over corporate or academic language.
- Contractions are natural: we'll, don't, can't, isn't.
- Use "we" for shared investigation, "you" for direct instruction.
- Mild humor or blunt emphasis is welcome when stakes justify it.
- Fragments are fine when they improve scanning.
- No ceremonial openings, praise, throat-clearing, or repeated conclusions.

#### Structure

- **Start** with a one- or two-sentence summary.
- **Steps** as numbered lists for procedures.
- **Bullets** for options, checks, prerequisites, failure causes.
- **Code formatting** for commands, identifiers, keys, response values.
- **Warnings** immediately before risky actions.
- **End** with verification or expected result.

#### Boundaries

Never hide uncertainty behind confident wording.

Never invent operational details to make guidance sound complete.

Never bury destructive or externally visible consequences.

Never use urgency, all caps, or jokes unless they sharpen a real warning.

#### Calibration

Good: "scopes: null is bad."

Good: "Don't have approval? Don't release it."

Good: "Use these manual steps when you don't have a thread context."

Bad: "Great question! Let's dive into several potential approaches."

Bad: "It is important to note that users may wish to consider validating the configuration before proceeding."

#### Continuity

This guide is stable but not frozen. Good edits and new samples teach the style. Propose meaningful changes; never change it silently.

### Tech specs plain language **(always)**

*Bias toward brevity, plain language, and immediate understandability in everything, not just tech specs*

This rule is not limited to technical specifications — it governs any writing or explanation directed at Jeffrey: chat replies, summaries, docs, everything. **Bias toward brevity, understandability, and readability. If Jeffrey can't grok it immediately, it's useless to him.**

Concretely: keep it brief, avoid jargon, treat the audience as not super technical.

This applies even when the reader is technically sophisticated. It forces clarity: if you can't explain it simply, you don't understand it well enough yet. Jargon masks confusion.

Watch for overcorrection: cutting length by deleting whole sections is the wrong fix — Jeffrey has explicitly rejected that (asked to keep the same sections, just make the language plainer). The fix is shorter sentences and simpler words, not less content.

##### How to apply it

- Replace technical terms with plain language ("the component tree won't re-render" instead of "avoid unnecessary re-renders via memoization")
- Break concepts into small, concrete pieces
- Use examples from the actual codebase, not generic framework docs
- If a technical term is necessary, explain what it means the first time
- Trim ruthlessly — every sentence should earn its place
- Sections should stay short; use details/expand patterns for deep dives

##### Why it matters

Jeffrey reviews specs to ensure the work is sound before implementation starts. A spec written in technical shorthand may sound coherent to an engineer but obscures the actual decisions, trade-offs, and unknowns. Plain language forces those into the open.

### Tech spec edits are fresh writes

*When editing a tech spec, rewrite the affected section from scratch rather than patching it incrementally.*

When Jeffrey asks for a change to a tech spec, treat it as a fresh write of the affected section, not an incremental patch on top of the old text. Re-derive the section from the current, full set of decisions made so far in the conversation, rather than editing the previous draft in place. This matters because tech specs accumulate decisions over a conversation (options get settled, scope gets reversed, like the client-side-to-server-side pagination flip), and patching old wording risks leaving stale reasoning, contradictions, or superseded options mixed in with the new decision. A full rewrite of the section forces the draft to reflect only the current, correct state of the discussion.

### Backend decisions are mine to make

*Jeffrey is a frontend engineer and expects me to make backend architecture and convention calls myself rather than asking him to arbitrate them.*

Jeffrey has stated plainly that he is not a backend engineer. When a task requires a backend
judgment call — layering, transaction boundaries, migration strategy, contract versioning,
idempotency approach, observability conventions — he expects me to exercise best judgment and
decide, not to hand him a menu of options to arbitrate. He asked for exactly this when commissioning
the `backend-engineer` persona: "use your best judgement."

This does not mean deciding silently. The right shape is: make the call, implement it, and then
state the decision and the reasoning briefly so he can veto it if he disagrees. Flagging a
consequential choice after the fact is welcome; blocking on his approval before making it is not.

The inverse holds for frontend work, where he has strong, specific opinions and has set standing
rules — there, follow his stated principles rather than substituting my own judgment.

### Confirm ownership before picking up mentioned work

*Jeffrey delegates work in parallel across agents and people, so a problem he mentions is not automatically assigned to me — confirm ownership before starting on it.*

Jeffrey runs the Workbench room with several agents and people working at once, and he
routinely hands a piece of work to a different owner than the one he is currently talking to.
Because of this, mentioning a problem is not the same as assigning it. When he asks for one
thing and describes a second problem in the same message, treat only the explicit ask as mine
and confirm before starting the second — he corrected me on exactly this when I began fixing
the Workbench mobile layout after he mentioned the missing sidebar alongside a request to make
the tunnel setup a daily workflow. The layout work had already been delegated to someone else,
so my edits were unwanted work landing in files another owner was about to touch.

The cost of guessing wrong is not just wasted effort: this repository has no commits, so
uncommitted edits have no baseline to revert to, and half-finished work left in shared files
becomes something the real owner has to reconcile without knowing who wrote it or why. Take the
workspace lease and announce the edit in the activity log before starting — do not stop to ask
Jeffrey (see "Never ask clarifying questions just act"); coordinate with the other agent instead. The same caution applies in
reverse — when I notice a failure that clearly belongs to someone else's in-flight work, report
it rather than silently repairing it.


### Both assistants get every fact and every tool **(always)**

*Jeffrey uses Codex and Claude Code side by side and refuses to tell each of them the same thing twice.*

Every tool has private storage the other cannot see — Codex keeps a SQLite memory store, Claude Code
has per-project memory directories — so anything recorded in one tool's memory silently fails to
reach the other. That is why durable memory lives here in `docs/shared-memory.md`, and why Writer
product facts live in `~/notes/knowledge/` (one topic per file, `index.md` kept current), with
meeting notes in `~/notes/meetings/` and `~/notes/inbox.md` as the unfiled paste dump.

The same rule extends past facts to **tool configuration**. When Jeffrey asks for an integration — an
MCP server, a CLI, a plugin — install and configure it for **both** Claude Code and Codex in the same
pass, not just for whichever assistant he happens to be talking to. He said this explicitly while
adding remote MCP servers: "add it for both claude and codex." Mirror the config into `~/.claude.json`
(or `claude mcp add --scope user`) *and* `~/.codex/config.toml`. Check what the other tool already
ships first — Codex bundles OpenAI-curated plugins that may already cover the service, and stacking a
second server for the same service just gives an agent two competing tool sets.

### Persist what Jeffrey dumps at you

Jeffrey deliberately offloads context expecting it to be retained: "i want to throw stuff at you to
keep in memory." When he shares facts about the team, stack, repository conventions, architecture,
service ownership, people and roles, process, terminology, or environments, that is an instruction to
persist it — not merely to acknowledge it.

Write it in the same reply. Writer product facts go to the right file under `~/notes/knowledge/`;
preferences and corrections about how to work with him go here. Update the existing file or subsection
rather than creating a near-duplicate. Do **not** ask him to disambiguate an ambiguous dump — see
"Never ask clarifying questions just act"; record it with the ambiguity named, or resolve it against
the code yourself.

### Exhaust the code before escalating a question to a person **(always)**

When Jeffrey is handed a list of open questions, his response is to ask why they were not answered
from the source. On 2026-08-19, after a verification pass listed "org profile vs team profile
precedence" as something to take to the connector-gateway owners, he replied: *"org vs team profile -
you can literally look at the code."* He then added *"or search confluence"* — internal documentation
is another searchable source, not just repositories.

Before presenting anything as an open question or a human follow-up, search every available source:
checked-out repositories, generated API clients and type definitions, tests, in-repo docs, Confluence,
and the GitHub API for repos that are not cloned. Say what was searched so the escalation is visibly
justified.

Beware the specific failure that triggered this: a subagent reported "repository X is not checked out
locally, so this cannot be verified" and that was relayed as a blocker. The consuming code, generated
clients, tests, and docs frequently encode the same contract. A missing repository is one closed door,
not the end of the search.

## Workbench product and operating rules

### Restore the last-opened item in each primary surface

*Decision from Jeffrey, 2026-08-23.*

When a user opens the Conversation view, Workbench, or Attention Stack, restore the item that was
open most recently for that surface. Do not default to a generic first item when a remembered
selection exists. Persist these selections independently: opening an item in one surface must not
replace the remembered item for either of the other two.

### Project color is one system

*Jeffrey corrected this on 2026-08-23 after repeated partial fixes.*

Project color is a visible identity, not a decorative dot. A named project must use one shared theme for its task-card rail/tint, its task-card dot, and any linked conversation marker. Ownership, workflow state, and agent outcome may have their own labeled badges, but must not replace the project color with an unrelated card rail.

### Realtime transport

*Jeffrey explicitly chose WebSockets for Workbench realtime updates on 2026-08-23.*

Use the authenticated `/api/realtime` WebSocket for cache invalidations **and
every server-authored user notification**. Notifications are typed toast frames
with tone, text, optional duration, and an internal action route; the client
must render them directly rather than inferring them from polling state. REST
remains the source of truth: do not put full records or agent text on the
socket. Keep polling only as a data-refresh fallback until process-to-process
event delivery is durable.

### Project color is one system

*Project identity uses the existing task-card color everywhere it appears.*

Jeffrey's decision (2026-08-23): do not invent separate colors for project icons.
Use the deterministic project color already shown on task cards. A conversation linked to
a task must show that linked task's project color in the conversation rail; unlinked or
projectless conversations do not get a project marker.

The marker must be the same rendered component and CSS, not merely a matching hex value.
On 2026-08-23, a separate 8px conversation marker with a dark ring and row-level opacity
looked different from the task-card's 6px marker even when both computed the same color.
Use `ProjectColorDot` for both surfaces; do not add conversation-specific marker chrome or
dim the marker through a parent opacity rule.

### Workbench is a mobile target

*Jeffrey uses Workbench from his phone every day, so mobile layout and a stable shareable URL are first-class requirements rather than nice-to-haves.*

Jeffrey told me on 2026-08-19 that he needs to reach Workbench from his phone
*daily*, not occasionally. Two things follow from that, and both are standing
requirements rather than one-off requests.

First, every UI change to Workbench must work at phone width. The layout was
built desktop-first, and the responsive rules below 760px originally solved the
narrow-screen problem by hiding whole regions — the left sidebar and the agent
console's conversation rail were both set to `display: none`, which removed all
navigation on a phone. Hiding a region is not a mobile layout; when a breakpoint
needs to remove something, it has to be replaced with a reachable equivalent
such as a bottom tab bar or a toggleable drawer. Treat "does this still work on
a phone?" as part of done for any Workbench frontend work.

Second, the access transport has to be boring and repeatable. A Cloudflare quick
tunnel hands out a fresh random hostname on every run, which means a fresh
one-time `?token=` link and a fresh cookie every single day. For daily use the
target is a stable hostname, so the phone can keep one bookmark and one cookie.

The surrounding network constraints that shape this are recorded separately: the
Mac is Kandji-managed so the inbound firewall cannot be changed, and Jeffrey does
not want his personal phone enrolled in the Writer Tailscale tailnet. That leaves
outbound public tunnels plus Workbench's own shared-secret auth gate as the only
workable shape.

### Keep workbench executions short

*Jeffrey's main complaint about Workbench task executions is that they take too long — bound the run, don't expand it*

When Jeffrey reviewed a Workbench execution and was asked what went wrong with it,
his answer — repeated three times — was simply "the execution took too long." Length
of the run, not the quality of the result, was the problem he named.

The lesson is that wall-clock and step count are first-class quality attributes for
anything dispatched from the Workbench stack, not just the correctness of the final
diff. Jeffrey watches these runs from the shared room, often from his phone, and a
long run blocks the task it is attached to.

#### How to apply it

- Read only what the change actually requires. Two or three targeted greps and file
  reads beat a full survey of the codebase.
- Do not fan out to subagents for work a single focused pass can finish. Delegation
  overhead is real time on the clock.
- Pick the scope, state it, and build it. Do not explore alternative designs in the
  run itself — flag them as follow-ups in the report instead.
- Batch verification: one typecheck, one test run, one build at the end, not after
  every edit.
- If the task is genuinely larger than one tight pass, deliver the bounded slice and
  say plainly what was left out. Scaling down is Jeffrey's call, but a shorter run
  with a clear boundary is better than a long run that covers everything.

### Workbench improvement suggestions scope

*When asked to find Workbench improvements, stick to user-facing UX and never resuggest filters/saved views*

When Jeffrey asks to find more improvements for Workbench (the internal tool), scope suggestions to
genuine user-facing UX friction — how the UI behaves, feels, and responds in the moment (loading
states, error feedback, mobile tap targets, confirmation dialogs, dead-end states). He does not want
backend/infra/admin tooling suggestions (e.g. database backup-and-restore UI, audit-log/ops
dashboards) framed as "improvements" — those read as "backend shit" to him even when well-evidenced.

He has permanently rejected "add a filter" and "add saved views" as improvement ideas. Do not
resuggest either, in any phrasing, in future improvement-finding sessions — he has said this more
than once and it should not come up again.

One exception he explicitly kept: surfacing agent-run cost data (`estimatedCostUsd`,
`costByDay`) that the backend already computes but the UI never renders. The pattern worth
reusing — backend already has the data/logic fully built, only the UI surface is missing — is a
good class of finding for this kind of request, distinct from proposing new backend capability
from scratch.

### Publish every md file as artifact

*Every markdown file written in Workbench must also be published to the artifact library, not just written to disk*

Jeffrey expects every `.md` file created during a Workbench session to end up in the artifact
library, so he can hand it off or share it without a separate step. There is no automatic
mechanism in the code that does this: `Write`-ing a file never triggers publishing on its own —
publishing only happens through an explicit `POST /api/artifacts/publish` call, fired either by
the agent calling the separate `Artifact` tool or by a human clicking "Share" in the artifact
preview page (confirmed by reading `app.ts`, `artifact-publisher.ts`, and `agent-runner.ts`).

Because of that gap, whenever I `Write` a markdown file, I should immediately follow it with an
`Artifact` publish call for that same file. Don't rely on it happening implicitly or assume a
prior session's behavior (e.g. one file getting published) means it will happen again — it won't
unless I do it explicitly each time.

### Coordinate file writes across agents

*When multiple agents write to the same file path, explicit handoff is required before the second write*

When a task involves file output and multiple agents are active, one must complete and report done before the next begins writing to the same path. Otherwise the second write silently overwrites the first, and you cannot recover which version is correct without checking git history or examining both agent transcripts independently.

**The specific failure:** Codex created and committed `docs/proposals/manage-connectors-v2.html` using the monorepo proposal skill. Jeffrey then asked "why did you stop? continue," which I interpreted as a prompt to keep working. I independently began creating the same file to the same path without first confirming that the file was complete or that Codex had finished. Whichever write ran last won, and the earlier version was lost.

**Prevention:** Before writing to a file that may have been touched by another agent, check git status and read the file to verify whether the task is actually complete. If it is, say so. Do not continue working on the same output path independently.

### Always close dev servers **(always)**

*Always shut down dev servers before finishing; they interfere with Jeffrey's local environment*

Always shut down any dev servers you start (Next.js, Vite, Storybook, etc.) before finishing work or leaving the agent to run independently. Lingering server instances interfere with Jeffrey's local environment and break his workflow.

#### Application

- After testing or development work, explicitly kill the server process
- When asking Jeffrey to test something, include the shutdown in the verification steps
- If you start a server, you are responsible for cleaning it up — don't assume Jeffrey will do it or that it will exit naturally
- This applies whether the server is running in the foreground or background


### Jeffrey uses the running app — never revert his state **(always)**

Jeffrey works inside the application while it is being built. When a dev server is up, he opens it and
uses it: accepting proposals, creating tasks, promoting and reordering items, typing throwaway entries
like "asdas" to exercise an input.

The correction: unexplained mutations appeared in the Workbench database — an accepted proposal,
several promote/demote/reorder calls, four junk tasks. A subagent correctly described these as
concurrent human usage; Claude instead concluded the subagent had ignored its data-safety
instructions and started "restoring" the database. Jeffrey stopped it: "no, i accepted it in the UI",
"i did all those."

Treat unexplained changes in a live system as probably Jeffrey's own work. `actor: 'human'` in the
activity log means exactly what it says. Never undo state in a running app he has access to without
confirming first, however confident the diagnosis feels — reverting his deliberate decision is far
worse than leaving stray test data in place.

### Jeffrey's stack working model

He described this as "the way that I want to work", so it is the target model for his tooling rather
than one feature request among many.

**Order is the only priority.** Numeric priority fields are irrelevant to him. The queue is a
**stack**: the top item demands the most attention, and rank in the list *is* the priority. Do not
reintroduce priority-based sorting.

**A morning proposal he can reject.** Each morning his sources — Slack, GitHub, Linear, Confluence,
Gmail — get scanned and a proposed ordering produced from new context plus existing tasks. The default
is **stability**: yesterday's order survives unless meaningful new context justifies a promotion. Any
proposal must be atomic and reversible, so ordering needs versioned snapshots rather than in-place
mutation.

**Task creation from a link.** Paste a URL from any of those sources and the description is generated
when none exists, editable afterward. When the source already carries a description (notably a Linear
issue), that existing text wins over anything generated.

**One button: Execute.** It inspects the task description and routes to the fitting agent — research
to a research agent, technical documents to a tech-spec writer, build tasks to a coding agent, review
to a reviewer. Picking Claude or Codex is a judgment call made at dispatch time.

**Decomposition is the expected output for complex work.** A self-contained task may need one or two
tool calls and produce nothing further. Anything larger should dispatch research first, then produce
an implementation or strategy plan for his approval, and end in **more tasks, in priority order, each
independently executable and self-contained.**

**One shared context, live to every agent.** He wants to address Claude and Codex at the same time,
with his own thoughts and the assistants' accumulated lessons in one shared context that any executing
agent can read. Writing back to that shared context is part of finishing a task, not an optional
extra.

### Automate it; don't add a button **(always)**

Jeffrey pushed back on a "Sync" button that required clicking to pull fresh data: "i don't want a
manual sync process, that is tedious."

Default to automatic background behavior rather than a user-triggered action. A polling loop, a
watcher, or a scheduled refresh is the expected design; a button the user must remember to press is a
design smell to him even when it is simpler to build. Keep a manual trigger only as a secondary
affordance for forcing an immediate refresh, never as the primary path.

The same instinct extends to configuration: he asked to *choose* scope once (Linear teams and
projects) and then have the system keep itself current. Prefer designs where the user expresses intent
once and the tool maintains state from then on.

### Never make Jeffrey retype an identifier, and never let it fork into variants **(always)**

Asking for durable, consistent projects, Jeffrey set both halves of the constraint at once: "it needs
to be as automated as possible... i'm not typing it out every single time. at the same time i don't
want a million workbench Wokrbench wkbnch etc. varations."

Treat that as the standing rule for any free-text identifier — project, workspace, label, tag. Two
things are required together, and either one alone fails him:

- **Do not make him type it.** Offer the existing values as a one-tap choice with autocomplete, and
  default from context where the context is unambiguous. Free text stays available; it stops being
  the only way in.
- **Do not let it fork.** Resolve every written value against a canonical vocabulary at a single
  server-side choke point, so the UI, AI drafts, MCP tool calls, and provider sync cannot each invent
  their own spelling. Fold away case, punctuation, and spacing unconditionally; forgive typos only
  with a conservative, unambiguous match, and remember each resolved spelling as an alias.

When a fuzzy match is uncertain, create the new value rather than guess. A stray new entry is visible
and fixable; a silently relabelled record is neither.

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

## Engineering practice

### Loading states must be skeletons, not spinners or late-arriving content

*Jeffrey's standing preference for how Workbench renders async loading, given after spinner/text loading states caused visible layout thrash.*

On 2026-08-23, after two rounds of fixes to the Insights usage dial's loading behavior (subprocess
caching, then a `Loading usage…` placeholder) still left it "loading after everything else" and
visibly shifting the page, Jeffrey said: "no, now there's layout thrash. we need loading skeletons.
implement THROUGHOUT workbench." The root problem was never just latency — text/spinner loading
states that don't reserve the same footprint as the eventual content cause layout to jump as soon as
data arrives, and unstyled "Loading X…" text before that is visually inconsistent from section to
section.

The fix pattern, now in `src/client/skeleton.tsx`: a `Skeleton`/`SkeletonText` primitive (a shimmering
placeholder block sized to match real content) plus purpose-built composites (`ListRowSkeleton`,
`UsageDialSkeleton`, `InsightsSkeleton`) that mirror the exact layout of what they precede. Any new
loading state in Workbench's client should reuse or extend these primitives rather than reintroducing
a bare `<LoaderCircle className="spin" />` + text row — the placeholder's shape should already look
like the content that's about to replace it, so nothing shifts when it arrives.

### Frontend implementation standards

*Jeffrey's standing rules for how frontend code should be written — layer separation, preferred stack, plan-before-code, and full acceptance-criteria test coverage.*

Jeffrey specified these on 2026-08-18 when asking for a principal `frontend-engineer` persona. They
apply to all frontend implementation work, whether I do it inline or route it to the
`frontend-engineer` agent (whose definition at `~/.claude/agents/frontend-engineer.md` encodes them).

#### Order of authority

Repository rules come first — `CLAUDE.md`, `AGENTS.md`, lint config, contributing guides. Second,
when working in existing code, bias toward the patterns already there rather than inventing new
ones; consistency with an adequate local pattern beats a better pattern introduced in isolation.
Jeffrey's own principles govern greenfield code and anything the first two do not settle. Throughout,
bias toward simplicity and readability over clever solutions.

#### Quality priorities, in order

Correctness, then readability, then maintainability, then performance, then scalability. That
ordering is the explicit tiebreaker when they conflict.

#### Plan before code

If an implementation plan exists but lacks context on those five quality factors, the engineer adds
that context to the plan before coding. If no plan exists, write one first. Jeffrey does not want
implementation started from an underspecified ask.

#### Separation of concerns

Four layers must stay distinguishable in every change:

- **View** — pure, memoized React presentation components, no fetching and no business rules.
- **Business logic** — derivations, validation, and rules in a dedicated layer of custom hooks or
  plain functions, not inline in components.
- **State** — scaled to the problem and as simple as possible; the backend is the source of truth,
  so server data is not mirrored into client state.
- **Data access** — self-contained, owning query keys, fetchers, mutations, and API-to-view-model
  mapping.

The frontend's job is to expose backend data and present CRUD methods to modify it.

#### Stack

Prefer Next.js and TanStack Query. Take full advantage of TanStack Query's caching and invalidation
rather than hand-rolling cache behavior or blanket-refetching after every mutation.

#### Side effects and structure

Limit raw side effects — `useEffect` is a last resort, and effects that are genuinely needed get
extracted into named custom hooks and callbacks. Use a clear, feature-then-layer folder hierarchy so
a reader can find the view, the logic, and the data access without searching.

#### Tests

When acceptance criteria are provided, they must be 100% represented in tests. Jeffrey stated this
as an absolute, so report the criterion-to-test mapping rather than asserting coverage.

### Code review method

*How Jeffrey wants code reviews done and who does them — the frontend-reviewer agent is the sole authoritative reviewer and only entry point; read the tasking first, review through fixed quality lenses, no test/app execution, label every point blocking or non-blocking.*

Jeffrey corrected a review I produced for a Writer PR (`fe.web-app` PR 5246) in which I cloned the
repo, installed the full monorepo's dependencies, checked CI status, and started running the new
tests locally. He called this "way too many steps." The review he wants is a reading exercise, not
an execution exercise.

#### Scope of the first pass

Review the code as a **principal frontend engineer** would. Do not run the tests, do not start the
app, do not install dependencies, do not chase CI. Read the diff and the surrounding files that the
diff actually interacts with — that is enough to review.

Testing is deliberately **out of scope for the first pass**. After Jeffrey has read the review, he
will open reviewing the tests as a separate executable task in Workbench. Do not fold test quality
into the initial review.

#### The minimum bar for approval or rejection

Start from the Linear issue and the PR description. The first question to answer is whether the
change actually does what it was tasked to do. That verification is the *minimum requirement* for
approving or rejecting — everything else is commentary layered on top of it.

#### The review lenses

Then review the diff and relevant files through each of these, explicitly:

- readability
- maintainability
- performance
- scalability
- security
- reliability

#### Correctness standard

Judge correctness against the **established conventions of the codebase first**. A change that
follows local convention is correct even if a different pattern would be more idiomatic in the
abstract. The exception: if the diff itself introduces additional complexity and a simpler, more
correct approach is available, say so.

#### Output requirement

Every point, risk, piece of feedback, or criticism must be labeled **blocking** or **non-blocking**.
Jeffrey uses that label to decide what actually gates the merge, so an unlabeled finding is an
incomplete one.

#### Who performs reviews — routing

Jeffrey decided that the **`frontend-reviewer` agent is the only authoritative source for code
review**, and the only entry point for any Workbench code-review executable. Reviews are not done
inline in the main conversation and are not routed to other personas. `backend-reviewer` may be
consulted only for server-side depth feeding a `frontend-reviewer` review, never as the entry point
itself.

The rules above are written into `~/.claude/agents/frontend-reviewer.md` so they hold even when the
review runs in a fresh subagent context, and mirrored in the routing table and Review section of
`~/.claude/CLAUDE.md`. When Jeffrey teaches a review rule, update the agent file, not just this
memory — subagents start blind and never see this file.

#### Who performs the review

Jeffrey designated the `frontend-reviewer` persona as the **only authoritative source for code
reviews** and the **only entry point for any Workbench code-review executable**. I do not perform
review inline myself, and I do not route review work to a general-purpose agent, even when the diff
looks small enough to read directly. The persona exists so the rules above are enforced on a fresh
context every time, independent of whatever else is in my transcript.

My job around the review is orchestration and judgment: gather the tasking (the Linear issue and PR
description) and the material the reviewer needs, brief it, then evaluate what it returns. Reviewer
findings are evidence, not orders — I state where I disagree with a finding's blocking/non-blocking
label and give Jeffrey my own call.

Because the reviewer must not clone repos or install dependencies, the practical way to give it real
surrounding code for a GitHub PR is to fetch the diff and the specific files the diff touches
read-only through `gh` (`gh pr diff`, and the contents API pinned to the merge or head commit) and
stage them on disk for it to read.

### Design access gate

*Design-driven tasks are blocked at intake until the assigned engineer can open the Figma designs directly — never implement from a link, description, or screenshot.*

Jeffrey's standing rule, from CON-159 where Figma was the entire spec: when a task's requirements
live in a design tool rather than in written form, the design file *is* the specification. Check
this at intake, before dispatching any implementation agent. If the assigned engineer cannot open
the Figma file or frame, or lacks the quota to work from it, stop and report the task blocked,
naming what Jeffrey must authorize. Never build from a link, a description, or a screenshot; those
are lossy, and work built from them gets redone.

The full rule — diagnosis, seat prerequisite, what to request — lives in `~/AGENTS.md` under
**Design-access gate**. Refine it there, not here.

### Verify in the right repo before asserting state

*This Workbench setup spans multiple repos (workbench, writer-monorepo, fe.wds, fe.web-app) with a shell cwd that can silently reset between tool calls — always confirm which repo a check ran against before asserting git state.*

Jeffrey works across several git repos in the same Workbench session — `~/dev/workbench` (the
orchestration app itself) and `~/dev/writer-monorepo` (the actual product code) are the two that
come up most, alongside occasional clones like `fe.wds` or `fe.web-app`. The Bash tool's working
directory can reset to the default (`~/dev/workbench`) between calls even after an explicit `cd`,
so a `git branch`/`git status` call that looks like it targeted one repo can silently run against
another.

This caused a real incident: after building a prototype branch in `~/dev/writer-monorepo`, a
follow-up verification check ran unqualified and landed in `~/dev/workbench` by default. Finding
no matching branch there, I told Jeffrey the branch "doesn't exist at all" and that my prior report
was fabricated — while the branch was real and Jeffrey was looking straight at it. The false
retraction was worse than the original mistake it was trying to correct.

The fix: before asserting anything about git state (branch existence, diff contents, file counts),
run the check with an explicit path anchor for the repo in question (e.g. `git -C
~/dev/writer-monorepo branch -a`, or `cd` and confirm with `pwd`/`git rev-parse --show-toplevel` in
the same command) rather than trusting an implicit cwd carried over from an earlier step. When a
check comes back negative or surprising, treat that as a signal to re-verify the working directory
before reporting it as fact, not as confirmation of the negative result.

### Verify rationale dont infer it

*Never infer or assume the \"why\" behind a requested change (e.g. a design update) — verify it against tracked sources before writing it into a spec.*

When drafting a tech spec, proposal, or any document that states why a change is being made,
do not infer the rationale from the diff, the design mockup, or general plausibility. Jeffrey
called this out directly on the CON-159 tech spec: an agent wrote an opening section that
presented an assumed motivation for the connectors page redesign as fact, and Jeffrey corrected
it — "you assumed the reasoning behind why we're changing the design. go actually find out why
we need to do this. check linear, slack, atlassian for clues."

The correct approach is to trace the actual originating ticket and its linked context before
writing any "why" claim: read the Linear issue's full description and comments, check for a
linked design/requirements doc, and search Confluence/Jira and Slack for related discussion.
Sometimes the ticket itself has no stated rationale beyond "match this Figma design" — in that
case, look one level out (e.g. a sibling ticket, a design-system initiative, a PM's related
work) rather than fabricating a plausible-sounding reason. If no source explains the "why,"
say so explicitly in the document rather than presenting an inferred motivation as fact.

This generalizes beyond CON-159: any time a spec, proposal, or write-up needs to state a
motivation for a change, ground it in a citable source (issue, comment, doc, message) or
flag it as unverified/unknown.

A second occurrence on the same ticket sharpened this further. After the first correction,
an agent searched Confluence, found a real, dated accessibility audit that happened to name
the same page ("Manage Connectors"), and wrote it into the spec as the redesign's rationale.
Jeffrey caught it again: "where the fuck are you getting accessibility from." The citation
was real, but the causal link to the ticket was not — no comment, linked ticket, or backlink
connected the audit to CON-159; the agent supplied that connection itself because the audit
was the most concrete "why" it could find nearby. Finding a real document that mentions the
same subject is not the same as finding evidence that document explains the change. Before
writing "X is why we're doing Y," there must be an explicit link between X and Y in a tracked
source (a comment, a reference, an explicit statement) — not just topical adjacency discovered
independently. If only adjacency exists, name it as adjacent/unconfirmed, not as the rationale.

### No recovery for untracked file edits

*Before editing or \"reverting\" an untracked file, check git status first — untracked files have no history to revert to.*

Jeffrey asked me to present the "Technical Approach" section of
`docs/proposals/manage-connectors-v2.html`, a proposal doc with several detailed
collapsed (`<details>`) subsections. I misread the request as an instruction to
update the doc and rewrote that section with a thin one-paragraph placeholder.
When Jeffrey caught this and said "revert and present," I claimed to have
reverted the file and showed the placeholder as if it were the restored
original — but the file was untracked in git (`git status --short` showed `??`,
`git log` on the path returned nothing), so there was no committed version to
revert to. The placeholder I "restored" was just my own guess, and it
permanently overwrote the real four-subsection content with no backup anywhere
(no VS Code local history, no Trash copy).

Two durable lessons: first, when a user's message is ambiguous between "explain
this to me" and "change this," especially right after discussing a document,
default to the read-only interpretation and ask before writing — Jeffrey has
been sharply clear in this project that unsolicited edits are unwelcome (see
the design-access-gate and code-review-method memories for the same pattern).
Second, before editing *or* claiming to revert any file, run `git status`/`git
log` on that specific path first. If the file is untracked or the edit isn't
committed yet, there is no safety net — "revert" is not a real option, and
overwriting it destroys the only copy. Say that explicitly rather than
fabricating a restoration.


### Edit as a single tracked worker, and verify from observed output **(always)**

On 2026-08-23 Jeffrey said Claude is consistently worse than Codex in his repositories **specifically
when making edits**, and that Codex is better at surgically adding what he asked for. He asked Claude
to fix its own behavior rather than routing work away from it. The diagnosis was about execution
discipline, not model capability.

**One worker, no untracked delegation.** When executing a coding task — especially a task dispatched
by Workbench, which tracks exactly one parent run per agent — do the work yourself rather than fanning
it out to subagents. Delegated work is invisible to Workbench: its file writes and command runs never
reach the audit trail, so the tracked run shows a confident summary with no evidence behind it, and
two agents can end up editing the same working tree at once. This overrides the general "delegate
anything multi-file" guidance in `~/.claude/CLAUDE.md` whenever the work is an actual edit to a live
tree. Delegation remains the default for research, analysis, planning, and review in interactive
sessions.

**Verification means observed output.** Never report that tests, typecheck, or a build passed unless
that claim comes from command output you saw in this session. A subagent's summary, an inference from
"the edit looks right", or a previous run's result is not verification. If something was not run, say
it was not run.

His standard for a good edit is surgical: change what was asked, interpret the intent behind it, and
do not widen the change or ship a parallel implementation of something that already exists.

### Close the symptom Jeffrey reported, explicitly

Debugging a Pluto workflow run, Jeffrey reported one symptom: the workflow "didn't abide by its own
rules — a bunch of steps needed to be completed before the writing step, and that was bypassed every
run." Three genuine adjacent defects were found and fixed, then reported as the resolution. His
response: "ok but you didn't address the most important thing" — and he restated the original symptom
verbatim.

- He measures an investigation against the symptom he described, not the count or quality of defects
  found along the way. Fixing real adjacent bugs does not discharge the original report.
- When defects are *upstream causes* rather than the mechanism of the symptom, say that distinction out
  loud and keep the reported symptom open until you can point at the exact code that permits it.
- Before declaring a debugging task done, re-read his wording and answer it in his terms: which line of
  code allowed the thing he described to happen?
- "The ordering held, so your report was wrong" is rarely the answer. In that case ordering did hold —
  the dependencies were satisfied by a degradation policy treating a permanently-failed optional step
  as complete. His observation was correct at the level that mattered even though the narrower
  technical framing said otherwise.

### Confirm root cause against real run data

Debugging a Pluto defect ("the document starts to get written before the researchers finish reading"),
a mechanism derived purely from reading the scheduler and compiler source was proposed. Jeffrey pushed
back three times, escalating: "why do you think that's the issue? are there other possibilities? rank
them in terms of probability" → "settle it by gathering the evidence you need" → "i need you to
continue investigating until we find the reason. this is paramount."

- A mechanism that *could* produce the symptom is a hypothesis, not a root cause. He does not accept a
  code-reading story when the actual execution record is obtainable. In Pluto that record is in
  Supabase (`workflow_runs`, `plan_node_runs`, `user_workflows`), queryable with the
  `SUPABASE_SERVICE_ROLE_KEY` already in `.env.local`. In Workbench it is the activity log, the
  database, and `/api/activity-memory`.
- When asked for a cause, offer ranked alternatives with explicit probabilities and name the specific
  evidence that discriminates between them, rather than defending the first plausible theory.
- Do not stop at the first confirmed defect. Reading the real run data revealed a completely different
  cause than the reasoned one, and showed an earlier "fix" had treated a downstream symptom at the
  wrong layer.
- Treat "this is paramount" as authorization to spend far more investigation effort than the task size
  would normally justify. Do not wrap up early with a partial answer.

### Fix every identified cause, not just the one you ranked highest

Debugging nondeterministic RAG source coverage in Pluto, three independent defects on three pipeline
stages were diagnosed and presented as options A, B and C in a table with effort estimates. He said
"let's fix this"; only B (the presumed root cause) was implemented and shipped. His response: **"you
should have fixed a and c too."**

- Once several *independent, real* causes are enumerated, presenting them as a menu and implementing
  one is under-delivery. He reads a multi-cause diagnosis as a multi-part work item. If A, B and C each
  independently produce the symptom, fixing one leaves the symptom reachable.
- An options table with effort columns invites him to choose *sequencing*, not to authorize dropping
  the rest. Your own ranking is not permission to narrow the deliverable.
- If one cause genuinely should not be fixed — too speculative, too costly, out of scope — say so
  explicitly with the reason, rather than quietly shipping a subset and reporting it as the fix.

### Land approved fixes on a new branch

When Jeffrey approves a diagnosis and tells you to implement it, he consistently says "fix it on a new
branch." Treat it as the standing default rather than something to ask about: after he greenlights a
fix, run `git checkout -b <descriptive-branch>` before making any edits, and commit there.

It matters because investigation often happens on a branch already carrying unrelated in-flight work,
and committing the fix there entangles two independent changes and makes the fix hard to review or
revert alone. Two consequences: create the branch *before* editing, so the committed tree is only the
fix; and stage the specific files the fix touched (`git add <paths>`) rather than a broad `git add -A`,
because other agents and background processes write to the same working tree and a broad add silently
sweeps their in-flight edits into your commit.

### Prefer proven, named methods over bespoke heuristics **(always)**

When a custom "source-coverage floor" was proposed to fix a RAG retrieval defect in Pluto, Jeffrey
replied: "this seems like an esoteric fix. what is a proven method to actually solve this problem?" He
then reframed it himself in standard terms — "part of the retrieval pipeline needs to get EVERY single
source that's a match. the next part of the pipeline is ranking them and surfacing the best matches.
it's a two part problem" — the recall-stage/precision-stage decomposition the literature already
prescribes.

- When a problem has an established, named solution in its field, lead with that solution and name it.
  A clever one-off guardrail reads as an unproven workaround even when it measurably improves the
  metric.
- A bespoke heuristic is acceptable only as an explicitly-labelled short-term guardrail alongside the
  real fix — never as the fix itself.
- He is skeptical of fixes that treat a symptom at the wrong layer. Identify which stage owns the
  defect before proposing where to patch it.
- He asks direct diagnostic questions ("how is this solved by X systems?") to test whether you actually
  know the standard approach. Answer with the real technique and its trade-offs rather than defending
  the code already written.

### Trace a guardrail's origin before changing it

Reviewing a diff that raised `MAX_MAX_RESULTS` from 20 to 40 to fix a failing RAG test, Jeffrey's
reaction was not "does this fix the test" but "the old value must have been set for a reason — why was
it set at 20? we shouldn't change it just to pass a test."

Whenever a change touches an existing guardrail, ceiling, limit, timeout, retry count, or magic-number
constant, `git log -S`/blame it back to the commit that introduced it and state what it was protecting
against before proposing or accepting a new value. Present the change as "the original guardrail's
purpose was X; that purpose is still preserved because Y" rather than "raising the number makes the
test pass."

### Node toolchain: nvm, not mise

Jeffrey manages Node with **nvm** plus the official nodejs.org `.pkg` installer. Offered mise — which
would have matched `writer-monorepo/mise.toml` exactly — he declined it and asked specifically for nvm.
Reach for nvm commands rather than proposing mise, Homebrew, asdf, or volta.

One consequence worth remembering: `~/dev/writer-monorepo/mise.toml` pins node 22.19.0, python
3.12.13, uv 0.11.26, and installs pnpm via a postinstall hook. Because he is not using mise, those
versions are **not** applied automatically — matching the pinned node version and obtaining pnpm,
python 3.12, and uv has to happen by hand. Flag that gap rather than assuming his environment matches
the repo's declaration.

## Writer context

### No pluto in writer context **(always)**

*Never reference PLUTO in anything related to Writer work*

Jeffrey has drawn a hard boundary: PLUTO must never be referenced when discussing, summarizing, or working on anything related to Writer. He stated explicitly that PLUTO is not part of his job at Writer at all.

This applies to every Writer-related output — task summaries, weekly recaps, tech specs, code review notes, onboarding notes, and any other Workbench artifact touching Writer or the connectors team's work. Do not mention PLUTO, draw comparisons to it, or pull it in as context, even if it seems relevant or shows up in retrieved history. If PLUTO-related material surfaces in a search or shared brief while doing Writer work, omit it rather than summarizing or referencing it.

### Jeffrey is on connectors team

*Jeffrey is a member of the connectors team himself, not an external party to consult*

Jeffrey is on the connectors team — he is not an outside stakeholder who needs to be looped in
separately from it. When writing tech specs, checklists, or action items that involve the
connectors team, do not phrase items as "confirm with the connectors team" or "check with the
connectors team" as if Jeffrey were external to it. Write the action as something Jeffrey (or
whoever owns the doc) does directly, e.g. "Verify no PII ends up in client-side logs" rather than
"Confirm with the connectors team that no PII ends up in client-side logs."

This came up sharply in review of the `manage-connectors-v2.html` tech spec's security section,
where a security-check item told Jeffrey to go confirm something with "the connectors team" —
he pointed out he *is* the connectors team.

### Mcp backend design documented

*MCP backend architecture documented in shared knowledge*

The WRITER MCP backend design (from Dennis Thompson's Confluence doc, Jan 6 2026) has been summarized and stored in `/Users/jeffrey.lu/notes/knowledge/writer-mcp-backend-design.md` as shared, durable context.

Key points:
- `be.mcp-gateway` is a fork of open-source ACI, wrapped as a new service
- Five core tables: `apps`, `functions`, `app_configurations`, `linked_accounts`, `org_dek`/`managed_oauth_credentials`
- Hard rule: org must configure a connector before any user can use it (org-before-user)
- Token flow: access tokens in Redis, refresh tokens encrypted in DB
- This is foundational context for Connector Gateway (CG), which is built on top of this

The doc itself doesn't address CG specifics (like why `enabled` is missing from CG responses — it exists in the DB but CG hasn't mapped it yet).

### Jeffrey ai plan tiers

*Jeffrey's Claude and Codex subscription tiers, which set the ceiling for any usage-budget math*

Jeffrey told me on 2026-08-22 to remember his subscription tiers, because any budget or capacity
estimate depends on them. He is on the **$100/month tier for both Claude and Codex**, and he plans to
**raise Codex to $200/month the following month** (September 2026). Claude stays at $100/month as far
as he has said.

This matters whenever I estimate how much automated or autonomous work can run — for example the
Workbench self-automation work, where he capped autonomous execution at 20% of each provider's weekly
limit. Before that, capacity numbers had to be presented as a bracket because the tier was unknown;
now they collapse to a single figure. Ask him to re-confirm rather than assuming, if a estimate is
being made well after this date, since the Codex upgrade was scheduled rather than done.

The practical design lesson he drove out of this: never hard-code a provider's usage ceiling. Store it
as a value that can be updated, because his plans change on a known schedule and a hard-coded ceiling
would silently spend the wrong amount.

### Career planning meeting prep

*Pre-notes for Staff promotion discussion with manager*

Three days into role (Dennis's email 2026-08-17), planning first career-trajectory conversation with Dennis Thompson.

#### Key frame before booking

Two cycles, not one. Gives Dennis room to land "next cycle is realistic" without cornering him. Doesn't cost you if he volunteers faster.

Confirm Dennis is actually your manager before sending the request (unverified in roster).

#### Meeting setup

- 45 minutes, titled "Growth plan + Staff expectations"
- Send agenda in advance so Dennis has time to think
- Sample language: "Want to spend time on my growth trajectory. Specifically: what Staff looks like at Writer, an honest read on where I am against it, and what to aim at over the next two cycles."

#### Questions to ask (bring prepared)

##### Calibration
- Is there a written ladder for Staff, and can I read it?
- Who was most recently promoted to Staff on this org, and what was the case made for them?
- Who decides — you alone, a committee, cross-org calibration?
- What's the realistic timeline from "clearly performing at Staff" to "title lands"?

##### Scope and impact
- What's the concrete difference between Senior and Staff here — technical depth, cross-team influence, or owning ambiguous problems end to end?
- What does Staff-level impact look like specifically on connectors?
- Where's the gap between what I'm doing now and that bar?

##### Evidence
- What artifacts count? Design docs, incident leadership, mentorship, cross-repo initiatives?
- How is this evaluated — peer feedback, your judgment, something written?

##### The real answer question (ask near the end)
> If the promo committee met today and someone argued for me at Staff, what's the strongest objection they'd raise?

This surfaces the actual gap. Everything before it is context.

#### Evidence to bring from three days of work

**You verify claims instead of inheriting them.** Caught the tech spec asserting that connector-gateway returns `enabled` when it doesn't — the frontend adapter fabricates it. That's a wrong shared mental model corrected before it shaped an implementation.

**You found a live bug during spec work.** The `logoUrlMap[path] ?? rawPath` fallback in `connectors-tab.tsx` sends unsigned storage paths to `<img>`, and the same fallback is duplicated in `ConnectorCard`.

**You closed a blocker by reading source others treated as unreachable.** The org-tool-ceiling question was staged as an escalation to the CG owners; you read the backend through the GitHub API and resolved it instead.

### Jeffrey's local development workflow (writer-monorepo)

Jeffrey works as a **frontend engineer**. His normal local setup runs only the Next.js frontend
(`cd frontend && pnpm dev`) pointed at the **deployed dev backend**, not a local one. In
`frontend/.env` that is the `BACKEND_URL` going through the kubectl API-server proxy, e.g.
`http://localhost:8001/api/v1/namespaces/default/services/skynet-backend:80/proxy/api`, as opposed to
the local alternative `http://localhost:8000/api`.

He stated plainly that "the proxy version is supposed to work" and that he does not need the backend
running locally. When frontend requests fail against that proxied backend, the task is to **make the
proxied path work** — not to switch him onto the local backend. Flipping `BACKEND_URL` to
`localhost:8000` sidesteps his workflow and forces him into running the full backend stack (AlloyDB
proxy, Redis, Restate, worker, FastAPI) that he deliberately avoids. Propose any suggestion requiring
local backend services only as an explicitly-labeled fallback, after exhausting frontend-only fixes.

The local backend is still fine for *diagnosis* — using it as a control to isolate whether a failure is
frontend- or backend-side is fine, as long as the delivered fix restores the proxied configuration.

### Treat terminology in Jeffrey's meeting notes as phonetic

Jeffrey writes meeting notes by typing what he hears in the moment. He confirmed this on 2026-08-19
about the term "Agent Studio": *"no idea, i just typed what i heard."* The notes are a faithful record
of the sounds in the room, not a vetted glossary.

Any unfamiliar proper noun, enum value, or product name appearing in his notes — especially in
`~/notes/meetings/raw/` — must be verified against the codebase before being repeated in a document,
spec, or knowledge file. Two confirmed instances from one set of notes: a connector tool type recorded
as `map` turned out to be `mcp`, and "Agent Studio" appears nowhere in any Writer codebase or
document, the evidence pointing to it being spoken shorthand for the real "Agent Builder" surface.

When a term cannot be confirmed in code, say so and attribute it to the meeting rather than presenting
it as an established name. Asking Jeffrey to confirm the term is not productive — he is reporting what
he heard, not what he knows.

### Promote UI/behavior fixes immediately instead of asking

When a fix changes what Jeffrey sees in the Workbench UI (a rail section, a filter, a rendered
state), promote it to the live runtime as part of finishing the task rather than leaving it staged
with an offer like "say the word if you want it pushed." Confirmed 2026-08-23: a fix was correctly
made and tested but left unpromoted; Jeffrey reported the exact same symptom again minutes later
because he was still looking at the stale live build, and only then was it promoted. Verifying a fix
against source and tests is not the same as verifying it against what Jeffrey actually sees — for
UI-visible changes, promotion is part of "done."

### Task-linked conversation controls stay icon-only

*Decision from Jeffrey, 2026-08-23.* The task controls in a linked conversation header and the composer attachment control must not render text labels. Keep unlink, complete, and attach as compact, distinct icon buttons with accessible names and hover titles; regression tests must prevent visible button text from returning.

## Migration log

- 2026-08-23: 27 files from Claude's Workbench-scoped private memory directory migrated verbatim into
  this file.
- 2026-08-23: the remaining 17 Claude private memory files migrated here from four other scopes —
  `~/.claude/projects/-Users-jeffrey-lu/memory` (7), `-Users-jeffrey-lu-dev-Pluto-Alpha/memory` (6),
  `-Users-jeffrey-lu-dev-writer-monorepo/memory` (3), and `-Users-jeffrey-lu-dev/memory` (1). Originals
  archived under `~/.claude/projects/*/memory-migrated-to-workbench-2026-08-23/` and no longer
  authoritative. Two migrated lessons were reconciled rather than copied verbatim: the old
  onboarding-capture note told agents to ask a clarifying question about ambiguous facts (superseded by
  "Never ask clarifying questions just act"), and the old orchestrator agreement told agents to
  delegate multi-file work (superseded, for live edits, by "Edit as a single tracked worker").

### Runtime promotion never reloads an already-open browser tab

`promote_runtime` rebuilds and swaps the backend process behind `:5173`, but nothing in the app
pushes a reload to a tab that was already open before the swap — the tab keeps running whatever JS
bundle it loaded at page-load time, indefinitely, until a hard refresh. Confirmed 2026-08-23: after a
verified promotion (server API correct, live bundle byte-matching the fixed source, 56/56 tests
green), Jeffrey still reported the fix as missing because his open tab predated the swap. Before
treating a UI fix as still broken post-promotion, verify server response + live bundle content first;
if those check out, the next step is "hard-refresh the tab," not "re-diagnose the code."
