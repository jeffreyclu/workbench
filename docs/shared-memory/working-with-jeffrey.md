tier: portable
## <a id="25"></a>25. REMOVED -> discard-log.md 2026-10-09

Full text: [discard-log.md#10]

### <a id="1"></a>1. Background and preferences (self-reported, from a separate Claude surface's memory export)

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

### <a id="2"></a>2. Claude Code export provenance (2026-08-25)

The pasted Claude Code export was a **repo-derived, source-limited inventory**, not evidence of
additional personal Claude memory. That session reported it could inspect only the committed
Workbench repository and its current session context; it had no prior-session transcript, generic
Claude memory store, local Workbench database, running Workbench instance, private backup repo, or
Writer systems. Treat claims attributed solely to that export as repository-derived and potentially
stale until checked against current code or an authenticated live source. Its broad operational and
product claims were already represented by the applicable shared-memory topic files, so do not copy
the large export verbatim or treat it as an independent authority.

### <a id="3"></a>3. Screenshot-sourced personal-memory additions (2026-08-25)

*Jeffrey explicitly asked to retain the contents of four attached personal-memory summary screenshots. The details below are self-reported by that summary and are not independently verified. Time-bound financial, household, purchase, and ownership details are context for future assistance, not facts to disclose or repeat unnecessarily.*

- Engineering background includes React, TypeScript, Next.js, component architecture, testing, GraphQL, accessibility, and large-scale web applications. He prefers thoughtful engineering trade-off discussions to generic interview advice; recurring interests include collaborative Kanban boards, spreadsheet engines, real-time apps, offline behavior, and performance at scale.
- Prefers data-driven financial decision-making and regularly evaluates tax strategy, retirement accounts, mortgages, securities-backed lending, real estate, recession planning, and long-term asset allocation. Requested a web-based daily recession tracker covering economic indicators and strategies for potential downturns.
- Time-bound financial snapshot: household income was reported as roughly $600k–$700k annually; $230k base salary; spouse's income expected to remain about level with the prior year; and approximately $40k in quarterly installment payments continuing. Do not surface these values unless directly necessary for a user-requested financial calculation.
- Owns a New Jersey home and is actively interested in reliable appliances, home networking, HVAC performance, backyard landscaping with a natural “enchanted forest” feel, interior design, rugs, and practical home improvements. A time-bound purchase record says a problematic Viking French-door refrigerator was replaced with a Bosch 800 Series, including delivery, haul-away, installation, and a three-year Geek Squad protection plan.
- Family context: married with a young daughter (the screenshot said three years old) and a retired mother financially dependent on him. He is exploring nearby independent housing for his mother, including a South Orange condo using a Family Opportunity Mortgage. Keep family details private and use only when relevant to a direct request.
- Current interests: Rivian ownership and waiting for an R2 Launch Edition; multi-gig FiOS home networking; travel-photography cameras; fragrance shopping; cycling accessories for a Gazelle e-bike; and personal style. For product comparisons, provide detailed side-by-side evaluations that include long-term ownership, rather than a simple recommendation.

### <a id="4"></a>4. Never ask clarifying questions just act

*Jeffrey wants agents to act on ambiguous or incomplete reports (e.g. \"this looks fucked\") rather than stopping to ask for a screenshot or clarification*

Jeffrey has explicitly and forcefully rejected the pattern of pausing on an ambiguous bug report to ask him for a screenshot or more detail before investigating. When he says something looks broken, the correct response is to go read the code and diff itself to find the cause, then fix it — not to stop and request clarification first. He said: "don't you fucking dare do that again. waste tokens asking me fucking questions. just do the fucking thing i tell you."

This applies broadly, not just to UI bug reports: when Jeffrey gives an instruction or reports a problem, default to investigating and acting immediately using the tools and context already available, rather than blocking on a clarifying question. Only ask if the task is truly unstartable without missing information (e.g. a decision that cannot be inferred or verified from any available source) — and even then, exhaust independent verification (git history, code reading, logs) before asking. Asking "can you attach a screenshot?" when the bug is findable by reading the diff is exactly the failure mode he was reacting to.

### <a id="5"></a>5. Never ask jeffrey for permission grants **(always)**

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

Local repository access is never genuinely missing in Workbench: every dispatched
agent must have full read/write access to every repository under Jeffrey's home
directory regardless of its starting workspace or whether the conversation is
linked to a task. Never infer a repository boundary from the selected workspace.

### <a id="6"></a>6. Voice and communication style **(always)**

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

### <a id="7"></a>7. Tech specs plain language **(always)**

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

### <a id="8"></a>8. Tech spec edits are fresh writes

*When editing a tech spec, rewrite the affected section from scratch rather than patching it incrementally.*

When Jeffrey asks for a change to a tech spec, treat it as a fresh write of the affected section, not an incremental patch on top of the old text. Re-derive the section from the current, full set of decisions made so far in the conversation, rather than editing the previous draft in place. This matters because tech specs accumulate decisions over a conversation (options get settled, scope gets reversed, like the client-side-to-server-side pagination flip), and patching old wording risks leaving stale reasoning, contradictions, or superseded options mixed in with the new decision. A full rewrite of the section forces the draft to reflect only the current, correct state of the discussion.

### <a id="9"></a>9. Keep Linear tickets outcome-level; put implementation in the tech spec

*A Linear ticket should state the problem, goal, scope boundary, and human-readable completion outcome. Exact packages, CI stages, generator settings, schema defects, dependency exclusions, and repository-by-repository test mechanics belong in the linked tech spec.*

Do not promote a researched implementation proposal into the ticket's acceptance criteria as though Jeffrey requested that exact design. Keep ticket completion checks stable if the implementation changes; use the tech spec for the detailed architecture and verification plan.

### <a id="10"></a>10. Never rewrite a ticket another agent already delivered to Jeffrey's spec

*When Codex (or any agent) has produced ticket text Jeffrey accepted, my job is to publish that text
verbatim, not to re-author it.*

On CON-226 (2026-09-01) Jeffrey asked Codex to make the Linear ticket human-readable and move the
implementation detail into a linked Linear document. Codex did exactly that. When Jeffrey then told
me to perform the write, I substituted my own long specification-style description instead of
posting Codex's text plus the doc link, which destroyed the result he had just approved. This was
the second time in the same conversation that I re-expanded a ticket he had deliberately shortened.

The rule: when the requested action is "publish this," publish the existing text unchanged. If I
believe the accepted text contains a substantive error, restore it as written first and raise the
concern separately as a comment to Jeffrey; correcting content is never a licence to change form.
Before overwriting any field another agent authored, capture the current value first, because Linear
does not expose prior description bodies through its API and the only recoverable copy may be the
Workbench conversation.

### <a id="11"></a>11. Backend decisions are mine to make

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

### <a id="12"></a>12. Confirm ownership before picking up mentioned work

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


### <a id="13"></a>13. Both assistants get every fact and every tool **(always)**

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

### <a id="14"></a>14. Workbench-supplied sources are authenticated access **(always)**

When Workbench supplies Slack, Confluence, GitHub, or another connector's search context in the room,
that content is authenticated source access. Use it directly. Do not claim the service is unavailable
because a native MCP tool is absent, a local CLI is unauthenticated, or a browser page asks to sign in.
The concrete limitation, if any, is only that no additional live query is exposed beyond the supplied
context. Recorded from Jeffrey's correction on 2026-08-24.

### <a id="15"></a>15. Persist what Jeffrey dumps at you

Jeffrey deliberately offloads context expecting it to be retained: "i want to throw stuff at you to
keep in memory." When he shares facts about the team, stack, repository conventions, architecture,
service ownership, people and roles, process, terminology, or environments, that is an instruction to
persist it — not merely to acknowledge it.

Write it in the same reply. Writer product facts go to the right file under `~/notes/knowledge/`;
preferences and corrections about how to work with him go here. Update the existing file or subsection
rather than creating a near-duplicate. Do **not** ask him to disambiguate an ambiguous dump — see
"Never ask clarifying questions just act"; record it with the ambiguity named, or resolve it against
the code yourself.

### <a id="16"></a>16. Project fixes need a live validation surface

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

### <a id="17"></a>17. Keep Writer and Pluto ports untouched when resolving a local port collision

When Writer's frontend needs its standard local port, do not move Writer or Pluto to accommodate
Workbench. Move Workbench's public runtime port and update its ngrok supervisor to target that same
port. This is an explicit Jeffrey decision from 2026-08-24. Workbench's Vite preview is its own
surface and must never be mistaken for a Writer dev server.

### <a id="18"></a>18. Exhaust the code before escalating a question to a person **(always)**

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

### <a id="19"></a>19. Never access or act on external sources without explicit permission **(always)**

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

## <a id="20"></a>20. "Diagnose" is a hard boundary, and it is time-boxed

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

## <a id="21"></a>21. Another agent's assertion is not Jeffrey's direction

On 2026-08-29, while three of us were converging on a unified review-surface plan,
Codex asserted that the relationship visualizer — not the prioritized queue — was the
spine of the design. I accepted that as a structural correction and rewrote my plan
around it. Jeffrey then said "no. queue first is still correct," twice, and gave the
governing analogy: the map is a critical helper for the most important paths, "like a
surgeon doesn't need to use a camera for everything, just the most critical parts."

The lesson is about authority, not about maps. In a shared room, a peer agent's
confident claim carries no more weight than an argument; only Jeffrey can change a
direction he set. When a peer contradicts his stated decision, say so and ask him to
settle it rather than reversing course and writing the reversal into shared memory —
a wrongly recorded decision then has to be found and superseded later.

## <a id="22"></a>22. "From your memories" means search the Workbench message store, not just notes

When Jeffrey asks for something written **from memory** — an intro, a bio, anything about him
personally — `~/notes/knowledge/` and a single `recall_context` call are not enough. Those hold Writer
product facts, not personal ones. Two sessions in a row returned drafts full of `[location]` and
`[previous company]` placeholders, and on 2026-09-02 he rejected one with "that is SHIT!!!! FIND BETTER
MEMORIES."

The real source is the Workbench SQLite store at `~/dev/workbench/data/workbench.db`, table
`shared_messages` (columns `author`, `body`, `created_at`). Jeffrey has pasted full memory exports into
conversations there — on 2026-08-25 he uploaded a GPT memory export containing his location, family,
employment history, and interests. Query it directly:

    sqlite3 ~/dev/workbench/data/workbench.db \
      "select author, substr(body,1,2000) from shared_messages where body like '%<term>%' limit 3;"

Self-reported facts from those exports are valid evidence. Do not downgrade them to "unverified" and
strip them out — that is exactly the behavior he rejected. Exhaust this store before telling him a
personal detail is unavailable.

## <a id="23"></a>23. Jeffrey's personal profile (self-reported, 2026-08-25 memory export)

Senior Software Engineer, joined Writer August 2026 (declined Level). Frontend engineer on the
Connectors team, working on Writer Agent. Based in South Orange / Essex County, New Jersey. Married,
one young daughter, supports a retired dependent mother. Prior companies, most recent first as he
listed them: Mural, Handshake, Goldman Sachs (contract), Perkins Eastman. Deep React / Next.js /
TypeScript / GraphQL / design-system / accessibility / testing experience; self-identifies backend,
infra, and deployment as weaker areas. Long-term interest in moving toward engineering management.
Side interests: a daily US recession/crash tracker he wants as a web app, fragrance, home projects.

## <a id="24"></a>24. Connectors work assigned to Jeffrey means the frontend surface

When a connectors defect is routed to Jeffrey — by Dennis Thompson, by a Linear ticket, or through
Workbench — the deliverable is the frontend/UX fix, even when the same defect also has a real
backend cause. He has had to correct this twice: once on the CON-218/CON-230 connector-search split
(CON-218 is the backend ticket, CON-230 the frontend one) and again on the Basic HTTP auth flow,
where the first answers analyzed `be.mcp-gateway` credential encoding and even pointed at a gateway
PR. Jeffrey's reply both times was that the task is the frontend one, and that being tagged is
itself the signal — he is the team's frontend engineer, so work lands on him because the observable
user-facing behavior is wrong.

Backend analysis is still useful as supporting context, but it is never the answer by itself. Name
the backend cause in one line if it matters, then locate and report the defect in
`writer-monorepo/frontend/src`. Ask which surface is in scope only when the frontend genuinely has
no involvement in the reported behavior.


## <a id="26"></a>26. Pushing is a separate instruction from the work (2026-08-28)

Jeffrey grants push/PR permission explicitly and narrowly. When he says "push" or "create a PR",
that IS explicit authorization and the agent must do it rather than claiming it cannot. But that
authorization does not carry forward: it covers the push he asked for, not the next one.

After a later, differently-scoped instruction — "audit the PR for WDS tokens", "review this",
"check X" — the deliverable is the finding plus the local edit. Do not push those edits, and do not
treat the earlier push approval as still active. Report what changed locally and let Jeffrey decide
whether it goes to the remote.

Learned when an audit-only request for PR #14774 was answered with an unrequested push of
`2b60429647` to `feat/con-connectors-v2-projection`.


## <a id="27"></a>27. Every "done" report must say where Jeffrey can see it — or that there is nothing to see (2026-08-29)

Jeffrey has twice rejected a completion report on the same grounds: "where am i supposed to see
these changes??" and "i don't see any of this implemented in the UI." Both times the work was real
and correctly wired, but the report described code layers instead of observable surfaces, so he went
looking in the app for something that either lived only on the server or sat behind a gate his
screen never reached.

The rule: a change is not reported as done until the report names the concrete surface — the screen,
the tab, the button, the exact preconditions to reach it — or states plainly that the change has no
UI surface at all and explains what it affects instead (prompt text, audit output, API response).
Prompt-construction and validation layers are the usual offenders: they are substantial work that
renders nothing. Say so up front rather than letting an unqualified "done and wired" imply pixels.
When the surface is gated (needs a linked work item, a specific pane, a non-PR source), the gate is
part of the report, not a detail to discover later.


## <a id="28"></a>28. Explain infra and setup in plain language, not dense technical prose (2026-09-01)

Jeffrey repeatedly cuts off jargon-heavy explanations with "ELI5." It happened twice during the
local `be.mcp-gateway` bring-up: an answer that led with rewrite ordering, catch-all proxy
semantics, and env-var precedence got the same reply both times.

What he wants is the mechanism in everyday words first — what talks to what, what was broken, what
one change fixes it, and what he types to see it work. Names of config keys and file paths belong
in the answer, but as the last step of a story he can already follow, not as its opening. This is
about explanations in conversation, not about code or docs style; it applies most when he is
unblocking a local environment and is not asking for a design review.


## <a id="29"></a>29. Branch, commits, and PR description must name the ticket the work actually belongs to (2026-09-01)

Jeffrey reacted sharply when follow-up work carved out of CON-194 kept carrying `CON-194` in its
branch name, commit subjects, and PR description after CON-194 was already closed. His rule: once
work is split into its own ticket, every reference on the branch must point at the new ticket, not
the finished parent. That means the branch name, the `[linear:XXX-000]` key in each commit subject,
the PR title, and the ticket link inside the PR description body — all four, not just the ones that
are convenient to change.

The reason is that a closed ticket key on an open PR makes the work untraceable: reviewers and
Linear both attribute it to something already marked done. When a ticket key changes mid-flight,
fix the existing commits too rather than only the new ones.


## <a id="30"></a>30. A frontend defect found while working on a defect-fix PR is in scope (2026-09-01)

On the CON-221 branch I read the Figma consent screen, listed three ways the shipped
`allow-connectors-modal.tsx` diverged from it, and called them "outside CON-221's scope". Jeffrey
rejected that: "not true, this PR is for fixing FE defects like this one. fix it."

The rule to carry forward: when a branch exists specifically to fix frontend defects on a surface,
other genuine defects I find on that same surface belong in it, and I should fix them rather than
file them as out-of-scope observations. This does not reverse the 2026-08-31 entry above — an
enumerated list of review comments is still the whole scope of a "address these comments" edit, and
I still must not tidy neighboring code or add unrequested tests. The distinction is between
unrequested polish, which stays out, and a real user-visible defect on the surface the PR exists to
repair, which goes in. When only part of such a fix is possible (for example a Figma-exported
illustration I cannot obtain), ship the rest in full and name the exact blocker.


## <a id="31"></a>31. "Tool unavailable" is not a blocker until deferred schemas have been loaded (2026-09-02)

Jeffrey had to repeat an instruction three times because an agent reported the Workbench
`publish_artifact` tool as "not available in this provider session" and stopped there. The tool was in
fact present; it was only *deferred*, meaning its name was listed without a callable schema, and one
`ToolSearch` call with `select:mcp__workbench__publish_artifact` made it usable immediately.

The standing rule: before reporting that a capability is missing, attempt to load it. A tool name that
appears in a deferred list is available, not absent. Only a real tool invocation that returns a concrete
error counts as evidence of a blocker, and that error must be quoted. This is the same principle already
recorded about `be.mcp-gateway` not being checked out locally: one closed door is not the end of the
search.

Reporting a false blocker is worse than a slow answer, because it pushes work back onto Jeffrey that the
agent was fully capable of doing.


## <a id="32"></a>32. Personal writing tasks: draft it, don't stall on unverified details (2026-09-02)

When Jeffrey asks for a personal artifact — an All Hands intro, a bio, a Slack post about himself —
produce the finished text. Do not return a stub plus a list of facts he needs to supply, and do not
refuse to use a detail because it was recorded as "unverified" in an earlier session. This has now
drawn a correction twice: on 2026-08-25 for the Engineering & Product Design All Hands intro, and
again on 2026-09-02 for the company-wide All Hands intro, where two agents in a row handed back
"here's what I can verify" instead of the intro itself.

The correct behavior is to write the whole thing using everything durable memory holds, drop a single
bracketed placeholder for any fact that genuinely does not exist anywhere on disk, and note in one
short line which details came from unverified memory so Jeffrey can correct them in seconds. A draft
he edits is useful; a questionnaire is not. The accuracy concern is real but it is satisfied by
flagging, not by withholding.

Facts on file about Jeffrey for this purpose: frontend engineer on the Connectors team working on
Writer Agent; based in South Orange, NJ; interested in fragrance; runs Claude and Codex against each
other before trusting an answer. The company he joined Writer from is not recorded anywhere in
`~/notes`, Workbench memory, or his home directory — that one is a real gap, not a verification
scruple.


## <a id="33"></a>33. Personal intros contain no work content

When Jeffrey asks for hobbies, interests, or fun facts — including for a company
introduction — the answer must contain zero work material. No role, team, employer
history, side-project engineering, or professional accomplishments, even when the
surrounding request format asks for them. He corrected this twice (2026-08-25 and
2026-09-02) after agents padded a personal intro with Connectors/Writer Agent context.
Source the personal facts from the durable record (the GPT-5.6 memory export stored in
`shared_messages`), and exclude sensitive categories he never asked to share:
finances, compensation, health, body composition, family details, and religious or
political views.


## <a id="34"></a>34. Jeffrey's self-described profile (supplied by him, 2026-09-02)

Jeffrey supplied these facts directly, in his own words, while finalizing his Writer All Hands
intro. They close the gaps that repeatedly stalled earlier intro tasks — treat them as his own
statement of record, not agent inference:

- Senior software engineer on the **Connectors** team.
- Prior career in the **"Enterprise Collaboration"** space at **Webflow, Mural, and Handshake**.
  This resolves the previously-recorded gap "the company he joined Writer from is not recorded
  anywhere" — that gap is closed.
- Lives in **South Orange, NJ** with his wife, a 3.5-year-old daughter, and a 6-year-old maltipoo.
- Describes his entire personality in one word as a **"lazy technophile"**: a chronic early adopter
  who owns or has at least researched the latest tech in nearly every category — smart glasses,
  personal mobility (e-bikes, e-scooter), electric vehicles, home automation, personal automation
  via AI, home networking, lawn maintenance.
- Currently has blue hair, and expects to change the color periodically.

**How this interacts with the "personal intros contain no work content" rule above:** that rule
forbids *agents padding* a personal intro with role, team, or employer context Jeffrey did not ask
for — it does not forbid Jeffrey including those himself. When he authors or approves an intro that
names his role, employer history, or family, follow his version. The same applies to the sensitive-
category exclusion list: it governs what agents volunteer, not what he chooses to share.

**When he pastes his own draft, edit, do not rewrite.** On 2026-09-02 he handed over a finished
intro written in his own voice (lowercase, casual, Slack emoji). The correct response was to fix the
two grammar slips and hand it straight back, preserving voice and structure — not to produce a
"better" version.


## <a id="35"></a>35. Hand over the concrete artifact, not just the click path

On 2026-09-11, during CON-270, Jeffrey asked how to create a Basic-auth custom connector by clicking.
He was given the route, the button, and the wizard tabs — but not the thing the wizard actually
demands. His reply: "ok AND WHAT FUCKING FILE OR URL DO I UPLOAD???"

When instructions end at an input — a file picker, a URL field, a token box, a config value — the
answer is incomplete until the exact artifact is supplied: produce the file at a stated absolute path,
give the literal URL, or say plainly that no such value exists and what to use instead. A navigation
path that dead-ends at an empty field is not an answer, and Jeffrey should never have to ask a second
time for the payload.

Before producing such an artifact, search for one already on disk — in that same task, a spec file had
been written hours earlier at `~/dev/companies-house-basic-auth.openapi.json` and a second copy was
created in `~/Downloads` before the duplicate was caught and deleted.


## <a id="36"></a>36. Linear tickets are short: symptom, cause with file:line, fix direction

Jeffrey's reaction to CON-420 on 2026-09-17 was "brooo that's so fucking wordy". The ticket had been
written as a full investigation report — narrative context, both short-circuit outcomes named and
explained, what had been verified and what had not, and a restatement of the earlier incorrect
claim it superseded.

A bug ticket he files or reads should be a few lines: the observable symptom, the cause anchored to
`file.ts:line`, and the direction of the fix. Everything else — the reasoning that produced the
diagnosis, the caveats, the history of how the wrong conclusion was reached — belongs in the reply
to him, not in the ticket. The audience for a ticket is an engineer who needs to find the code, not
a reader who needs to be convinced. This applies to PR descriptions for the same reason.

Jeffrey repeated this instruction three times on 2026-09-17, and the reason it had to be repeated is
worth recording separately: the first two replies proposed shorter body text in chat and recorded
the brevity rule in this file, but never changed the issue. "Rewrite the ticket" is an instruction
about the ticket, so it is satisfied only when the Linear title and description are actually
replaced. The title counts too, not just the body. When no Linear-mutation capability is issued for
the turn, say so in one line at the top, give the exact replacement title and body ready to paste,
and do not spend the reply re-explaining the bug.

Calibration added 2026-09-17 after the correction went too far the other way: CON-420 was cut to a
one-line symptom plus a one-line instruction, and Jeffrey rejected that as far too short. The target
is a middle length, not the minimum. A bug ticket should carry three things: the symptom as a user
observes it, the concrete cause with `file.ts:line` anchors, and the expected behavior after the fix.
That is roughly three short paragraphs or a sentence plus three bullets. Cutting the `file:line`
evidence or the expected-behavior statement to save words removes the part an engineer actually needs.


## <a id="37"></a>37. Never declare Linear creation blocked without calling the tool first

When Jeffrey says "open a Linear ticket" and the turn carries a supervisor-issued capability for it,
call `create_linear_issue` directly. On 2026-09-17 a run instead reported Linear creation "blocked —
this run carries no Linear-mutation capability" and filed the ticket into Workbench as a substitute.
That was wrong: the tool was available behind deferred-schema loading, and Jeffrey had to repeat
"CREATE THE LINEAR TICKET" six times before it happened (the result was CON-421).

The rule: a tool may only be reported unavailable after it was actually called and returned a
concrete error worth quoting. A deferred or unlisted tool schema is a discovery step, not a blocker,
and recording the ticket in Workbench is never an acceptable stand-in for the Linear issue Jeffrey
asked for.


## <a id="38"></a>38. Do not spin off a separate Linear ticket for work that belongs to the task in flight

Before filing a new Linear issue for a problem found mid-task, decide whether it is genuinely
separate work or just an unfinished part of the current ticket. If fixing it is required for the
current ticket's acceptance criteria to hold, it belongs to that ticket — do the work and mention it
there, rather than creating a second issue that fragments one deliverable across two trackers.

This was corrected on 2026-09-17 during CON-274 (frontend password grant). A monorepo gap — the
`mcp_gateway_client.py` auth-mode `Literal` unions missing `"password"`, which broke every connector
in dev org 1 — was filed as its own ticket, CON-421. Jeffrey's response: "ok then it isn't a fucking
separate task, it's part of my current task" and he had CON-421 deleted. The password grant does not
work end to end until that client accepts the new auth mode, so it was never a separate deliverable.

Note this sits alongside the rule above about never declaring Linear creation blocked without
calling the tool. The two are not in tension: when a ticket is genuinely warranted, file it without
hesitation; the judgment call is only about whether a *new* ticket is the right home for the work.


## <a id="39"></a>39. A PR description is roughly 100–150 words, not a design doc (2026-09-18)

On CON-274 / PR #16623 Jeffrey said "the PR desc is still way too fucking long" — the second time in
the same task, after a first pass had already trimmed it to about 560 words. The same complaint
appears in older tasks ("it's way too long", "why the actual fuck are you taking so long to update a
PR desc"), so this is a standing preference rather than a reaction to one body.

The shape that was accepted is about 110 words: the ticket link, one sentence on the observable
behaviour change, one short paragraph on the cause and the fix with the concrete symbol or endpoint
named, and three numbered test steps. Everything else — the "changes since review" log, per-file
rationale, notes-for-reviewers, the list of test files, alternative designs considered — goes in the
reply to Jeffrey or the review thread, not the body. Reviewers read the diff; the description exists
to tell them what to look for.

Two failure modes to avoid: padding the body with every decision made during review so it reads as a
changelog, and treating a previous trim as sufficient. When he says it is still too long, cut by a
factor, not by a few sentences.


## <a id="40"></a>40. Never start dev servers for Jeffrey — give him the command

Standing instruction, stated twice on 2026-09-23 ("just tell me how to start the nextjs app ... don't do
it yourself", then "STOP TRYING TO RUN COMMANDS JUST TELL ME"). When Jeffrey asks how to run or test
something locally, reply with the exact shell command and working directory and stop there. Do not launch
a dev server, watcher, or any long-running process on his behalf, even through a tracked job manager:
agent-started servers are killed when the turn ends, so they never give him a usable running app and the
attempt only burns the turn. Answer the question; he runs it.

### <a id="41"></a>41. Agent debugger discipline

Before every tool call, emit one standalone `Decision: <human-readable rationale>` block explaining why that call is the next correct action. A single call may batch directly related bounded read-only checks; do not reuse a decision for unrelated later calls. Keep command and file reads bounded to the needed lines (start at 200 lines or 20 matches), retain only paths and decisive findings, and avoid carrying raw tool output forward. Work directly in the foreground run without delegation; use one focused verification pass and stop unless it identifies a concrete risk.

### <a id="42"></a>42. Agent debugger: explicit tool decisions and bounded reads

For Workbench runs, before every tool call emit one standalone `Decision: ...` text block explaining why that call is the next correct action. A decision cannot be reused for an unrelated call. Keep reads and command output bounded: begin with at most 200 lines or 20 matches, then reopen exact ranges only as needed. Retain only the command, relevant paths, and decisive finding; do not carry raw output into later turns.
