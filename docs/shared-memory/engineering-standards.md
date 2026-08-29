## Engineering standards

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

**Audit before implementation (2026-08-24):** when correcting loading UX, first inventory every
loading state, compare each placeholder's actual DOM/layout against its loaded component, and identify
data-bearing components with no loading state at all. Do not start by fixing the most visibly broken
placeholder in isolation. The conversation window is a priority example: its existing generic list
rows and spinner must be evaluated against the real message-thread/header/composer structure.

**CSS fidelity is part of the match (2026-08-24):** matching the DOM alone is insufficient. A loading
skeleton must inherit or deliberately reproduce the loaded UI's container width, padding, minimum
height, surfaces, borders, radius, spacing, and narrow-viewport behavior. Do not use a generic
shimmer row inside a component whose loaded CSS is card-, panel-, or composer-shaped.

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

#### Never claim a UI matches the design without comparing it to the design

*Jeffrey rejected the same Manage Connectors V2 cards twice on 2026-08-27 — "actually we should make
the cards look more like the figma", then "brah, these cards don't look like the figma" — because
each restyle was reported as a match without being checked against the reference.*

A restyle is not done when the code changes; it is done when the rendered result has been compared
element-by-element against the design. Before reporting a UI change, enumerate the reference's
concrete attributes — layout direction, which text lines exist, badges, controls, iconography,
column count, heading case — and confirm each one in the implementation. When the design itself is
unavailable and only a screenshot exists, say plainly that the layout was approximated from a
screenshot and is unverified against Figma, instead of asserting parity. Asserting an unverified
match costs Jeffrey a full review round trip every time.

### Never let a server test spawn the real codex/claude CLI

`src/server/agent-runner.ts` really `spawn()`s the `codex`/`claude` binaries on `PATH` — there is no
test-mode flag that swaps in a stub. `agent-runner.test.ts` handles this correctly with a
`fakeAgentDirectory(codexBody, claudeBody)` helper (now shared at `src/server/test-fake-agent.ts`)
that writes tiny shell scripts to a temp dir and points `process.env.PATH` at it before the run
starts, then restores `PATH` in `afterEach`. On 2026-08-24, two tests in `app.test.ts` skipped this
and dispatched runs through the real API route without faking the agent binaries — they genuinely
spawned the real installed `codex` CLI. This was silently flaky (`npm test` alone was fine most of
the time but failed under full-suite load with a stalled `vi.waitFor`/timeout) and, worse, an
unhandled EPIPE from `child.stdin.end()` racing a SIGTERM-killed process left `npm test` exiting
non-zero even when every reported test passed.

Any new test that reaches a code path capable of dispatching a real agent run (`POST
.../execute`, `POST .../runs`, chat dispatch with `dispatchTo` set to an agent, etc.) must call
`fakeAgentDirectory(...)` first and restore `process.env.PATH` in `afterEach`. Separately, any place
that writes to a spawned child's `stdin` needs a `child.stdin.on('error', () => {})` guard — EPIPE
there is an expected race when the child is killed just before the write lands, not a real failure,
and leaving it unhandled fails the whole process even though vitest still reports every test green.

### When a task is blocked on an exhausted third-party account balance, stop probing and cut the code-level cost driver instead

On 2026-08-24, a Pluto-Alpha stability-check task (repeat a live-agent query 3–5 times) got parked
mid-run when the app's Anthropic account hit "credit balance too low." Jeffrey supplied usage
evidence that a top-up had recently happened, and the response was to send one more live "probe"
call to check whether the account was unblocked before committing to the full rerun. Jeffrey's
correction: **"stop fucking probing! we need to fix the billing issue."** Account credit/limits are
outside any coding agent's tool access — no billing API or credential is exposed in these sessions —
so an actual top-up is Taylor's (or finance's) action, not something to keep testing for. When a task
is blocked on that kind of external account state, the right move is not another billed call to check
if it cleared; it's to (a) say plainly that the balance itself can't be fixed from here, and (b) look
for a real code-level fix to whatever is driving the cost, so the same exhaustion doesn't recur once
the account is funded. In this case that meant shipping a `skipSmartTitle` request flag so the bench
harness stops paying for a fire-and-forget Haiku title call on every one of its ~32 billed cases —
a concrete cost reduction, not another status check.

**Correction, same day:** do not solve eval spend with an arbitrary numeric cap or confirmation flag.
Jeffrey explicitly rejected that as the wrong takeaway: the durable solution is a **layered evaluation
suite**. Make deterministic retrieval and evidence contracts the routine default; use frozen-evidence
generation tests to isolate citation/synthesis; keep a deliberately small, representative live-agent
canary suite; and reserve full live audits or repeated runs for explicit integration/stability work.
The harness must make those targets explicit, preserve tool traces and usage per run, and keep full
audits possible. Generalize this: cost control comes from testing the layer an assertion measures,
not from blocking a legitimate test run after an arbitrary number of calls.

**Status correction (2026-08-24):** Jeffrey later confirmed the Anthropic balance was topped up.
Do not cite account credit as the remaining blocker for the q21 stability task; verify the actual
Pluto runtime and the persisted trace/citation evidence instead.

### Claude autocompaction accepts `auto` or 100k–1M tokens

On 2026-08-24, setting Workbench's Claude launcher to `--autocompact 50000` made every run fail immediately: the installed Claude CLI only accepts `auto` or a numeric value from 100k through 1M. Keep the runner at `100k` (the minimum numeric setting), with a regression assertion in `agent-runner.test.ts`; never lower it to a bare `50000`.

### (always) Never fire billed live-agent eval runs on your own initiative

Immediately after the layered-eval work above landed, an agent started four back-to-back live
`--tier canary` q21 repeats without asking. Jeffrey's reaction: **"ok stop just RUNNING EVAL BENCH
WILDLY!!! WE RISK EXPLODING THE CLAUDE USAGE BUDGET AGAIN."** This is the third correction in the same
thread and it is about agent behavior, not harness code — do not respond to it by adding a cap or a
confirmation flag, which he already rejected once.

The standing rule: **any bench selection that posts to the live agent (`--tier canary`, `--tier live`,
or any `--only` selection whose questions resolve to a live tier) requires Jeffrey's explicit,
run-specific go-ahead in the immediately preceding message.** Free deterministic tiers — the default
`component` retrieval contracts and replay/frozen-evidence cases — can be run freely, because they
cost nothing. When a task's success criteria require live repeats, do every free and static part of
the work first, then stop and say exactly what you want to run, how many billed cases it is, and
roughly what it costs; wait for the answer rather than starting it. State the model/provider too.
Run only that approved scope, serially and in the foreground; stop as soon as the requested evidence
exists or any spend/error signal appears, and never add confirmation runs speculatively.

Approval does not generalize across steps. Jeffrey saying "ok, lets go!!!" to a *design or handoff*
proposal authorizes that design, not an unbounded series of billed runs downstream of it — and one
approved run is never authorization for a repeat loop. When in doubt about whether a prior "go" covers
the spend you are about to incur, it does not. On 2026-08-24, Jeffrey stopped an in-progress q21
repeat attempt after three completed billed calls; no further billed q21 call is authorized until he
explicitly approves a newly stated bounded run.

### Pluto RAG runtime spend is bounded before dispatch, not merely counted afterward

The 2026-08-24 RAG runaway fix established a separate production invariant from the eval-tier rule:
every `/api/agent-v2` run owns one shared token ledger across the Research Agent, producer rounds, and
model-backed RAG reranking. A model request must reserve a provider-bounded worst case before it is
sent; if that reservation cannot fit, the runtime degrades cleanly without making the call. Successful
calls replace the reservation with actual fresh-input, cache-read, cache-write, and output usage;
failed/cancelled calls release it. Optional reranking skips to deterministic RRF order when its
reservation is refused. Never regress this to a spent-only, post-response counter: that can observe an
overspend but cannot prevent it, and parallel work can pass the same stale headroom check.

### Claude cache traffic is a first-class Insight metric

On 2026-08-24, Jeffrey supplied a Claude `/usage` screenshot for recent work: an Opus session reported
**1.7K fresh input, 57.5M cache-read input, 2.0M cache-write input, and 184.4K output** ($53.08 of
provider-reported cost). Fresh input alone is not a useful proxy for either Claude traffic or spend.

Insights must preserve and display all four provider usage classes — fresh input, cache write, cache
read, and output — and label their sum as **total traffic**, never simply “input.” Cache reads are
discounted, not free, and can dominate a run by orders of magnitude. A provider `/usage` weekly
percentage is authoritative calibration evidence: the 57% observation in that screenshot was recorded
at 2026-08-24T17:02:00Z; its inferred SET ceiling remains an estimate of the current promotional
window, not a permanent plan limit.

This applies to every Workbench provider invocation, including unlinked shared-room replies and
synthesis calls. Task-linked replies share their `agent_runs` row and must be counted once; unlinked
replies have no run row, so their fresh input, cache write, cache read, output, cost, and cost source
must be persisted on `shared_messages` and included in Insights exactly once.

Historical rows without either cache field are **incomplete telemetry**, not fresh-only traffic. Do
not put them in Insights token totals or label their `input_tokens` as fresh input: the cache split is
unknown. Surface the number excluded so a missing split is visible rather than silently guessed. An
explicit reported zero is complete telemetry and remains eligible.

### Claude stream usage must be deduplicated by provider request

Claude's stream can repeat an `assistant` usage payload once per content block (for example thinking,
text, and tool use) for one actual provider request. Those replicas share `requestId` and message ID.
The runner must count that request once, then sum distinct provider requests; the terminal `result`
remains authoritative and replaces the provisional aggregate. On 2026-08-24, summing every replica
manufactured 1M-token run failures from about 155K tokens of final observed traffic. Any live
budget/cost circuit breaker must run after this deduplication, or it will terminate healthy work based
on presentation duplication instead of provider consumption.

### Workbench runs use one context, not a token kill switch

On 2026-08-24, Jeffrey rejected the per-run Claude token/cost cap after it
terminated useful work in seconds. Do not reintroduce it as a default safety
mechanism. Fix excess cache traffic at its source: Workbench Claude runs block
the `Task` subagent tool, do not forward subagent streams, and use aggressively
bounded task context, shared brief, retrieval, and conversation history. The
observed failure had roughly 1.0M cache-read tokens in under a minute for about
100 visible output tokens, so minimizing fan-out and repeated context is the
primary invariant; usage telemetry remains for diagnosis, not termination.

On 2026-08-28, after economy, standard, and deep runs repeatedly hit the
500k/1M/1.5M cached-input ceilings, Jeffrey explicitly removed the cached-input
kill switch for both Codex and Claude. Cached-input totals remain visible as
telemetry. Autocompaction and bounded context remain the controls for runaway
turns; do not restore a cache-token termination threshold.

On 2026-08-28, Jeffrey approved a non-fatal replacement: a completed turn that
reports at least 500k cache-read tokens retires its resumable provider session
before the next turn. It never cancels the active agent. Conversation UI also
shows a warning once recorded cache reads reach that threshold; bounded prompt
sections, deduplicated RAG, and compact conversation history remain the inputs
used to seed a fresh turn.

On 2026-08-28, Jeffrey clarified that post-turn retirement alone is insufficient
because one tool-heavy turn can still read millions of cached tokens. At 500k
deduplicated cache-read tokens during an interactive run, Workbench must ask the
agent to finish only its in-flight operation, emit a checkpoint, and automatically
continue the unfinished request in a fresh compact provider session. This is a
cooperative between-operation handoff, not SIGTERM/SIGKILL and not a failed run.

On 2026-08-28, after that cooperative handoff was live, Jeffrey removed the
remaining arbitrary work-termination caps. Do not kill a healthy foreground
agent because it crossed a profile-specific tool-call count or a fixed wall-clock
duration. Long work continues through cooperative cache checkpoints until it
finishes or Jeffrey cancels it. Command-safety blocks, provider-side failures,
manual cancellation, bounded prompt/retrieval/tool output, and Claude's
non-fatal provider autocompaction remain in force; they are not arbitrary
completion caps.

### Cache-read reduction: dual-agent dispatch stays, other levers are the approved path

On 2026-08-25, with cache-read at 521.9M tokens (30:1 over fresh input) across
Claude and Codex, Jeffrey ruled that running both agents on one request is a
core Workbench differentiator and is explicitly **not** a lever to cut — do not
propose reducing to one-agent-per-request as a fix. The approved levers instead
are: fewer/larger tool-loop steps per run, shrinking the cached prefix (tool
schemas, brief, retrieval), and deliberate session lifecycle management
(persist per conversation, compact after each turn, resume from compacted
state rather than raw history). As a first concrete step, `agent-runner.ts`'s
prompt-injected RAG budget was cut from 6,000/420/1,500 chars
(global/per-item/local) to 3,500/300/1,000 — the search candidate ceiling
(`PROMPT_MEMORY_CANDIDATE_LIMIT = 400`) is unchanged since that only bounds the
DB query, not what gets injected into the cached prompt.

### Codex session accounting: `input_tokens` includes cache reads

On 2026-08-24, Jeffrey's seven-day Codex session-log aggregate reported 637,606,464
`input_tokens`, 619,460,480 `cached_input_tokens`, 0 cache writes, and 1,646,031 output tokens.
For Codex, cached input is a subset of input, not an additional category: this means **18,145,984
fresh input (2.85% of inbound)**, **619,460,480 cache reads (97.15%)**, and **639,252,495 total
traffic**. Never add the first two figures when reporting total traffic or estimating usage. Codex
does not separately report cache writes in these local token-count events; zero is an unavailable
breakdown, not evidence that no cache was written.

### Usage calibration is an agent-owned local command, with one provider boundary

On 2026-08-24, Jeffrey asked that usage calibration become an easy command agents can run without
asking him to collect local token totals. `npm run usage:calibrate` is the canonical command: it
reports fresh input, cache read, cache write (when exposed), output, and total traffic over the last
seven days from Claude transcripts and Codex session logs. It may be run with `-- --days N`.

It must fail closed on calibration: Claude's CLI does not expose the authoritative weekly `/usage`
percentage, and Codex app-server percentages describe a short rate-limit window rather than the
ISO-week ceiling. Neither number may be silently recorded as a weekly calibration. Agents own the
ongoing local measurement and should run the command when asked to calibrate; an interactive Claude
`/usage` observation is still required to recalibrate Claude's weekly ceiling.

### Commits must never carry an agent Co-Authored-By trailer

Jeffrey's standing rule (2026-08-24): every git commit must show him as sole author, with no
`Co-Authored-By`/`Co-authored-by` trailer for Claude, Codex, or any other assistant. Claude Code
has a real settings toggle for this — `"includeCoAuthoredBy": false"` in `~/.claude/settings.json`
(applied globally on 2026-08-24) — which suppresses the trailer the CLI otherwise appends by
default. Codex has no equivalent config toggle as of 2026-08-24 (checked `~/.codex/config.toml`,
`codex --help`, and repo `.codex/AGENTS.md`/`config.toml`); the durable fix there is a standing
instruction in `~/AGENTS.md` to omit the trailer explicitly in every commit message, since nothing
in Codex's own config surface suppresses it. When a PR already carries the trailer, it can be
rewritten with `git filter-branch --msg-filter` (strip the trailer line + trailing blank line) and
force-pushed **only when the branch is unmerged, single-author, and not shared with other active
collaborators** — treat merged branches or shared branches as out of scope for a rewrite.

### A dominant activity-log entry can be a bug, not a usage signal — verify before "strengthening" it

On 2026-08-24, asked to find Jeffrey's most-frequent action and strengthen that path, the top entry
in `audit_log` by a wide margin — `POST /api/shared/conversations/:id/read` at 75% of all mutating
calls — turned out to be a bug, not real usage: `src/client/features/conversation/view.tsx` marked a
conversation read inside a `useEffect` keyed on the streamed message's `body.length`. Because
`messages` polls every 750ms while a run is active and the streaming body grows on nearly every poll,
the effect re-fired for the full duration of every run instead of once per new/completed message.

Before treating any dominant log count as a real behavior pattern worth reinforcing, check the code
path behind it — a count that's implausibly large relative to plausible user action (nobody re-marks
one open conversation as read thousands of times) is itself the signal, and the fix is to remove the
waste, not add capacity around it. The general anti-pattern to watch for elsewhere: a `useEffect`
dependency array containing a value that changes on every poll tick (a streaming/growing field) will
silently multiply that effect's side-effect frequency for as long as the poll runs. Prefer keying such
effects on discrete signals (message count, status) rather than continuously-changing ones, reserving
the continuous dependency for effects that genuinely need per-tick reaction (e.g. auto-scroll).
See `docs/activity-log-frequency-analysis.md` for the full analysis.

### `.gitignore` directory patterns must be anchored to the repo root

On 2026-08-25, the unanchored pattern `data/` in Workbench's root `.gitignore` (intended only for the
top-level runtime-state directory `./data`) also matched `src/client/data/`, a real source directory.
Git silently excluded 9 API client files there from every commit; a fresh clone of the repo could not
build, and the gap went unnoticed because each file still existed on disk in every developer's working
tree. It surfaced only when a promotion pipeline audit force-tracked one of the nine files as a special
case and flagged the rest.

The durable rule: any `.gitignore` entry meant to match one specific directory by name must be
anchored with a leading `/` (e.g. `/data/`, not `data/`), unless the intent is genuinely to ignore
every directory with that name anywhere in the tree. Before adding or reviewing a bare
`<name>/`-style ignore rule, check whether that name recurs elsewhere in the tree (`find . -type d
-name <name>`); if it does and the rule is only meant for one location, anchor it. This is a standing
review point for any future `.gitignore` change, not a one-off fix.

### A task's run kind must be re-inferred per conversation turn, not frozen at creation

On 2026-08-25, Jeffrey flagged that a linked task's kind (`execute`/`review`/`research`/`strategy`/
`analysis` — which drives agent persona and instructions) was classified once from the task's title
and description, then cached and reused for every future chat reply in that task's conversation
regardless of what a later message actually asked for. A task created as "research pagination
approaches" stayed `research` forever, even after Jeffrey wrote "now implement the cursor-based
approach" in a follow-up.

The fix (`classifyMessageIntent` + `classificationForLinkedItem` in `src/server/shared-room.ts` and
`src/server/agent-runner.ts`): each dispatched turn re-derives kind from that turn's own message text
using the same keyword rules as task-level classification, and uses it *only* to route that turn
(persona/agent for the `AgentRun` created for that reply) when the message carries a clear deliverable
signal. The task's stored classification (used for the task's own default routing and UI) is left
untouched, and ambiguous/context-dependent messages (short follow-ups like "why?" or "do it") fall
back to the stored kind rather than being misrouted by absence of a keyword. Any future change to task
routing must re-infer per-turn intent from the current message, not just from the task's original
title/description.

### Conversation history is evidence; one resolved turn objective is the instruction source

On 2026-08-28, repeated Claude and Codex runs spent dozens of tool calls re-investigating simple
requests because Workbench supplied a compacted transcript and shared brief without identifying
which user instruction was authoritative. Corrections competed with stale agent hypotheses, and a
terse “continue” could start a fresh run that rediscovered the repository instead of resuming the
unresolved request.

Every shared-room dispatch must now resolve one compact `TurnGrounding` before agent execution. A
dedicated, tool-free Haiku process extracts the current objective, observable acceptance criteria,
and explicit exclusions; the newest user correction wins. Both recipients of an Ask Both turn share
the exact same promise/result. A human-only deterministic fallback is mandatory if the classifier is
unavailable. The prompt labels history, memory, prior implementations, and agent narration as
reference evidence only, and repeats that the grounded objective is the instruction source.

Grounding is durably stored per human dispatch message in `shared_turn_groundings`. A retry loads that
exact snapshot and cannot silently adopt a newer queued request. A continuation reuses the preceding
stored objective without another model call; legacy conversations without a snapshot walk backward
through chains of “continue”, “???”, and urgency-only messages until they reach the concrete unresolved
human request. The Haiku worker is primed off the request path, and queued classification deadlines
start only when the request actually reaches the model—not while it waits behind warm-up. Future prompt
work must preserve these properties: latest correction wins, agent narration never becomes user intent,
Ask Both has parity, continuations are instant, and retries cannot drift across turns.
