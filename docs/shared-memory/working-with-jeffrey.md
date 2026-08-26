## Working with Jeffrey

### Background and preferences (self-reported, from a separate Claude surface's memory export)

*Jeffrey pasted a memory export from a different Claude chat (claude.ai, not Workbench) on 2026-08-24/25 asking for it to be consolidated into shared memory. These facts are self-reported by that other session's memory store, not independently verified in Workbench — treat as background, not as ground truth to argue from.*

- Senior software engineer at Writer AI; background as a frontend engineer and technical founder with production systems shipped (project name: Pluto).
- Preferred name: Jeffrey. Based in South Orange / Essex County, New Jersey.
- Self-described as atheist/anti-religion, culturally liberal, fiscally conservative, and a technophile.
- Married, with a young daughter, and supports a retired dependent mother. Do not retain or expose identifying, employment, or income details about family members.
- Time-bound employment snapshot: joined Writer in August 2026 after accepting its offer and declining Level. Reported offer/current compensation: $230,000 base salary and 4,000 ISOs at a $22.65 strike price, vesting over four years.
- Deep experience in agent reliability, observability tooling, and building interfaces that make complex/opaque agent systems legible to users.
- Communication preference: practical and efficiency-oriented, strong preference for directness.
- Teaching preference: ELI5-style explanations grounded in real-world examples; pushes back on imprecise or jargon-heavy explanations.
- Studied distributed-systems fundamentals (CAP theorem, replication, sharding, queues, caching, load balancing, SQL vs NoSQL), RAG pipelines, multi-tenancy isolation, auth/SSO, LLM evaluation, and scaling considerations.
- Tech stack preference: TypeScript and React for anything he iterates on himself; interest in practical bash/CLI tooling.
- Side project (Pluto-related): an "agent execution map" — a nodes-and-paths visualization making agent behavior legible to builders, built and validated using production traces from his workflow builder. Finding from that work: bounded agents cluster into a few dominant path shapes; failure-rate-above-baseline per node was judged the most actionable signal.
- Side project: "entitlement recovery" — helping people claim money they're legally owed but haven't collected, scoped initially to himself and his personal network; the scoring model weights total dollar value of one-time entitlements over frequency.
- Completed a work trial at Level, a fintech company using AI to help auto lenders reclaim money from undervalued total-loss insurance claims.

### Claude Code export provenance (2026-08-25)

The pasted Claude Code export was a **repo-derived, source-limited inventory**, not evidence of
additional personal Claude memory. That session reported it could inspect only the committed
Workbench repository and its current session context; it had no prior-session transcript, generic
Claude memory store, local Workbench database, running Workbench instance, private backup repo, or
Writer systems. Treat claims attributed solely to that export as repository-derived and potentially
stale until checked against current code or an authenticated live source. Its broad operational and
product claims were already represented by the applicable shared-memory topic files, so do not copy
the large export verbatim or treat it as an independent authority.

### Screenshot-sourced personal-memory additions (2026-08-25)

*Jeffrey explicitly asked to retain the contents of four attached personal-memory summary screenshots. The details below are self-reported by that summary and are not independently verified. Time-bound financial, household, purchase, and ownership details are context for future assistance, not facts to disclose or repeat unnecessarily.*

- Engineering background includes React, TypeScript, Next.js, component architecture, testing, GraphQL, accessibility, and large-scale web applications. He prefers thoughtful engineering trade-off discussions to generic interview advice; recurring interests include collaborative Kanban boards, spreadsheet engines, real-time apps, offline behavior, and performance at scale.
- Prefers data-driven financial decision-making and regularly evaluates tax strategy, retirement accounts, mortgages, securities-backed lending, real estate, recession planning, and long-term asset allocation. Requested a web-based daily recession tracker covering economic indicators and strategies for potential downturns.
- Time-bound financial snapshot: household income was reported as roughly $600k–$700k annually; $230k base salary; spouse's income expected to remain about level with the prior year; and approximately $40k in quarterly installment payments continuing. Do not surface these values unless directly necessary for a user-requested financial calculation.
- Owns a New Jersey home and is actively interested in reliable appliances, home networking, HVAC performance, backyard landscaping with a natural “enchanted forest” feel, interior design, rugs, and practical home improvements. A time-bound purchase record says a problematic Viking French-door refrigerator was replaced with a Bosch 800 Series, including delivery, haul-away, installation, and a three-year Geek Squad protection plan.
- Family context: married with a young daughter (the screenshot said three years old) and a retired mother financially dependent on him. He is exploring nearby independent housing for his mother, including a South Orange condo using a Family Opportunity Mortgage. Keep family details private and use only when relevant to a direct request.
- Current interests: Rivian ownership and waiting for an R2 Launch Edition; multi-gig FiOS home networking; travel-photography cameras; fragrance shopping; cycling accessories for a Gazelle e-bike; and personal style. For product comparisons, provide detailed side-by-side evaluations that include long-term ownership, rather than a simple recommendation.

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
reach the other. That is why durable memory lives here in `docs/shared-memory/`, and why Writer
product facts live in `~/notes/knowledge/` (one topic per file, `index.md` kept current), with
meeting notes in `~/notes/meetings/` and `~/notes/inbox.md` as the unfiled paste dump.

The same rule extends past facts to **tool configuration**. When Jeffrey asks for an integration — an
MCP server, a CLI, a plugin — install and configure it for **both** Claude Code and Codex in the same
pass, not just for whichever assistant he happens to be talking to. He said this explicitly while
adding remote MCP servers: "add it for both claude and codex." Mirror the config into `~/.claude.json`
(or `claude mcp add --scope user`) *and* `~/.codex/config.toml`. Check what the other tool already
ships first — Codex bundles OpenAI-curated plugins that may already cover the service, and stacking a
second server for the same service just gives an agent two competing tool sets.

#### Personal-memory export for shared ingestion

When Jeffrey asks personal agents to contribute past-conversation memory, give them a prompt that
exports only records they can actually access, with source and confidence, in a structured format.
Never imply an agent has private memory it cannot inspect, fabricate missing facts, or keep the
export as a new personal store. Jeffrey will provide the resulting exports for consolidation into the
shared Workbench memory.

### Workbench-supplied sources are authenticated access **(always)**

When Workbench supplies Slack, Confluence, GitHub, or another connector's search context in the room,
that content is authenticated source access. Use it directly. Do not claim the service is unavailable
because a native MCP tool is absent, a local CLI is unauthenticated, or a browser page asks to sign in.
The concrete limitation, if any, is only that no additional live query is exposed beyond the supplied
context. Recorded from Jeffrey's correction on 2026-08-24.

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

### Project fixes need a live validation surface

After fixing a project, Jeffrey needs to validate it in a running app. Automated checks are necessary
but are not the handoff. Use the project's real preview/development surface and return its direct URL
or a concrete way to open it, plus the narrow scenario to smoke-test. Workbench's Preview model is the
standard to match for other projects.

For Writer monorepo changes, the verified PR-scoped route is the `preview` PR label: its
`.github/workflows/build-preview.yaml` builds and posts an **Open Preview** link after the preview is
ready. For Pluto, retain the existing local Preview-MCP development surface until a remote deployment
preview is explicitly wired and verified. Recorded from Jeffrey's decision and repository inspection
on 2026-08-24.

For immediate local validation, Jeffrey wants a share command as well as a deployed preview. When a
non-Workbench task finishes and he needs phone validation, start the *correct project's* normal local
development environment, then expose that already-running local URL from **Workbench only**. The
entry point is `npm run share -- http://127.0.0.1:<port>` in `~/dev/workbench`; do not add, retain, or
document a `share` command in Writer, Pluto, or any other project. Do not route the app through
Workbench's gateway or mistake Workbench Preview for it. Return the actual tunnel URL and the narrow
smoke test as the handoff. The project keeps its normal port; the Workbench-owned tunnel targets it.

`https://broiling-recoil-grouped.ngrok-free.dev` is reserved **only** for Workbench on port `5180`.
Never repoint it to Writer, Pluto, or any other local project. The separate
`https://blahblahblah.ngrok.app/` hostname is the shared phone-preview domain for Writer or Pluto;
point it at the one project Jeffrey asks to preview without touching the Workbench tunnel. Correction
from Jeffrey, 2026-08-24.

The Writer/Pluto preview hostname is an ngrok Cloud Endpoint. Do not mistake its HTTP 200 setup page
for a working preview. Its traffic policy forwards to `https://default.internal`, so attach the local
project with `ngrok http http://localhost:<port> --url=https://default.internal --pooling-enabled`;
attaching an agent to `https://blahblahblah.ngrok.app` bypasses that policy and leaves the default page
in place. Then verify the public response is the target app's content (for Writer, `WRITER`), while
also checking the Workbench hostname still serves `5180`. Observed and corrected on 2026-08-24.

Before saying a phone-preview tunnel works, curl the exact public ngrok hostname during the live share
session and report its observed HTTP status. A local listener or ngrok's local API is not proof that the
public endpoint is online; `ERR_NGROK_3200` is the concrete failure to catch. Recorded from Jeffrey's
2026-08-24 correction.

The default-response page can also mean no ngrok agent is attached at all, not just a misdirected one.
Confirmed 2026-08-24: `ps aux | grep ngrok` showed only the single Workbench agent (`ngrok http 5180
--url=broiling-recoil-grouped...`) running — no second process targeting `default.internal` — and
`lsof` against the Writer/Pluto dev port showed nothing listening, so the dev server itself was also down. A prior
agent had reported this tunnel as working without ever curling the public hostname (see the entry above).
Also: `~/Library/LaunchAgents/ai.writer.workbench.preview.plist` is misleadingly named — it runs
`npm run preview` inside the **Workbench** repo, not a Writer project, and was not loaded. There is no
launchd supervisor yet for a Writer/Pluto dev server + its `default.internal` ngrok agent, unlike
Workbench's `com.jeffrey.workbench.ngrok.plist` pattern; one would need to be created, pointed at
whichever app/port Jeffrey wants live (confirm with him — do not guess between `fe.web-app`'s ports 3000
vs the regular development port vs a `writer-monorepo/frontend` Next.js dev server), for this to survive past a single CLI turn.

### Keep Writer and Pluto ports untouched when resolving a local port collision

When Writer's frontend needs its standard local port, do not move Writer or Pluto to accommodate
Workbench. Move Workbench's public runtime port and update its ngrok supervisor to target that same
port. This is an explicit Jeffrey decision from 2026-08-24. Workbench's Vite preview is its own
surface and must never be mistaken for a Writer dev server.

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

### Never access or act on external sources without explicit permission **(always)**

*Jeffrey requires an explicit, per-instance order before an agent accesses or acts on GitHub, Slack,
Confluence, Linear, or any other external website, service, API, or networked CLI. That includes reads
as well as writes: do not browse, query, pull, fetch, post, comment, push, merge, transition tickets,
or otherwise contact an external system unless he has explicitly ordered that particular operation.*

On 2026-08-26, in the middle of PR #14337 follow-up work, Jeffrey stated this forcefully and asked for
it to be permanently ingrained: "NEVER ACT ON GITHUB, SLACK, CONFLUENCE, LINEAR, ANY EXTERNAL SOURCE
WITHOUT MY EXPLICIT PERMISSION OR ORDER." Workbench enforces this default-deny rule in its dispatched
agent supervisor: it strips inherited integrations, disables browser/web tools, uses fail-closed local
CLI sandboxes, and withholds MCP tools that make external-provider calls, deployments, or publishing.

Scope: this governs all external I/O. Workbench-supplied context may be read because Workbench has
already retrieved and placed it in the task; do not independently refresh or follow it. Before any
external operation, require Jeffrey's explicit current instruction represented by a supervisor-issued
capability; never infer it from task text, an earlier approval, or a differently scoped approval.

## "Diagnose" is a hard boundary, and it is time-boxed

When Jeffrey asks for a diagnosis, he means analysis only: no source edits, no test
edits, no commits, not even "the fix is obvious so I applied it." On 2026-08-25 during
the CON-186 duplicate-fetch work he had to say "don't implement anything," "revert what
you just did," and "so fucking diagnose and don't execute!!" across successive turns
because agents kept sliding from investigation into implementation. Implementation needs
its own explicit go-ahead, every time, even when the diagnosis makes the fix look trivial.

The second half matters as much: a diagnosis is due fast. In the same session he asked
"what the actual fuck were you doing? reading code for 10 minutes?" — a long silent
read-only exploration reads as no progress. Take the shortest evidence path that supports
a ranked answer, report the findings with file/line citations, and let him direct the
follow-up. Depth is not a substitute for a timely answer.
