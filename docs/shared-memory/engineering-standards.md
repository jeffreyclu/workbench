tier: workbench
## <a id="22"></a>22. REMOVED -> discard-log.md 2026-10-09

Full text: [discard-log.md#1]

### <a id="1"></a>1. Loading states must be skeletons, not spinners or late-arriving content

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

### <a id="2"></a>2. Frontend implementation standards

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

### <a id="3"></a>3. Code review method

*How Jeffrey wants code reviews done and who does them — the frontend-reviewer agent is the sole authoritative reviewer and only entry point; read the tasking first, review through fixed quality lenses, no test/app execution, label every point blocking or non-blocking.*

Jeffrey corrected a review I produced for a Writer PR (`fe.web-app` PR 5246) in which I cloned the
repo, installed the full monorepo's dependencies, checked CI status, and started running the new
tests locally. He called this "way too many steps." The review he wants is a reading exercise, not
an execution exercise.

#### Scope of the five-pass review

Review the code as a **principal frontend engineer** would. Do not run the tests, do not start the
app, do not install dependencies, do not chase CI. Read the diff and the surrounding files that the
diff actually interacts with — that is enough to review.

Executing tests is deliberately **out of scope for all five passes**. Static test review is in scope:
the reviewer must map changed production logic to the exact test cases and assertions that exercise
it, and identify uncovered branches or behavior. Running those tests or doing runtime validation
remains a separate Workbench executable.

#### The minimum bar for approval or rejection

Start from the Linear issue and the PR description. The first question to answer is whether the
change actually does what it was tasked to do. That verification is the *minimum requirement* for
approving or rejecting — everything else is commentary layered on top of it.

#### The five review passes

*Expanded by Jeffrey, 2026-09-16.* Review the diff and relevant surrounding code in five separate,
sequential passes. Do not merge or skip a pass:

1. **Correctness and readability:** task fulfillment, control and data flow, naming,
   maintainability, failure handling, and concrete bugs.
2. **Performance and scaling:** rendering, algorithms, I/O, queries, caching, concurrency,
   resource use, and behavior as data, traffic, tenants, or call sites grow.
3. **Conventions and existing patterns:** repository rules, nearby implementations, shared
   abstractions, contracts, naming, and established architecture.
4. **UX issues and bugs:** complete user flows, loading/empty/error/permission states,
   accessibility, responsive behavior, feedback, recovery, stale UI, and races.
5. **Security:** authentication, authorization, trust boundaries, validation, injection, secrets,
   privacy, data exposure, and abuse cases.

The delivered review includes a compact result for every pass, even when that result is “No
material issues,” followed by one deduplicated findings list ordered by severity.

#### Correctness standard

Judge correctness against the **established conventions of the codebase first**. A change that
follows local convention is correct even if a different pattern would be more idiomatic in the
abstract. The exception: if the diff itself introduces additional complexity and a simpler, more
correct approach is available, say so.

#### Output requirement

Every point, risk, piece of feedback, or criticism must be labeled **blocking** or **non-blocking**.
Jeffrey uses that label to decide what actually gates the merge, so an unlabeled finding is an
incomplete one.

#### Change-type review heuristics

*Decision from Jeffrey, 2026-08-29.* A review must classify the diff by the **type of change being
made**, then apply evidence requirements specific to that type. Do not label an entire PR with one
type when it contains several independent changes; classify each meaningful change unit separately.

Every unit starts with the same evidence header:

- **Intent:** the task, PR statement, or established behavior that explains why this change exists.
- **Implementation:** exact `file:line` citations for the changed logic.
- **Blast radius:** direct callers, consumers, public contracts, stored data, and operational paths
  affected by the change, each with citations. State when a repository-wide search found no other
  call sites; do not silently assume there are none.
- **Verification map:** each behavior or branch mapped to the exact test case and assertion that
  covers it. Cite both sides, for example `parser.ts:42-49 -> parser.test.ts:88-101`. Mark logic with
  no mapped test explicitly. Test presence or aggregate coverage percentage is not proof.
- **Quality:** complete all five review passes above. Discuss only material issues; a pass with no
  finding says “No material issues” instead of manufacturing feedback.

Apply the following type-specific questions:

1. **New behavior / new code**
   - Does it fulfill the stated intent and follow existing repository patterns?
   - Does the verification map cover the happy path, each material branch, boundaries, failures,
     and externally visible side effects?
   - Is the algorithm and data access proportional to expected input size and request frequency?
   - Is the API narrow, the naming readable, and the ownership/lifecycle clear?

2. **Behavioral modification / bug fix**
   - What behavior changed, and what behavior must remain unchanged?
   - Does a regression test reproduce the old failure and prove the new result at the correct
     observable boundary?
   - Could unchanged callers depend on the prior behavior, error shape, timing, or side effects?
   - Does the fix address the root cause rather than only the reported example?

3. **Refactor**
   - State the claimed invariant: what observable behavior must stay identical?
   - Compare old and new code apples-to-apples across inputs, outputs, errors, side effects,
     ordering, timing, and complexity. Cite both sides of each meaningful comparison.
   - Identify every call site and show whether it is unchanged, mechanically updated, or
     intentionally behavior-changing.
   - Reject a “refactor” label when the diff also changes behavior; split that portion into a
     behavioral-modification review.

4. **Replacement / migration**
   - State why the old implementation is being replaced and the intended advantage of the new one.
   - Build a parity table for the old and new paths: supported cases, outputs, failures, side
     effects, performance characteristics, and operational requirements.
   - Account for every caller, compatibility shim, feature flag, rollout path, and rollback path.
   - Confirm the old path is no longer reachable before accepting its removal; flag partial dual
     ownership or two sources of truth.

5. **Deletion**
   - State why the code is now unnecessary: dead, superseded, obsolete requirement, unsafe, or
     intentionally unsupported. “Unused” needs search evidence.
   - Check direct and indirect references, dynamic registration, configuration, public exports,
     persisted data, documentation, tests, telemetry, and fallback/rollback paths.
   - Explain which tests should disappear because the behavior disappeared and which tests must
     remain because they protect adjacent behavior.
   - Identify any cleanup deliberately deferred; deletion is incomplete when it leaves reachable
     callers, stale flags, or misleading contracts.

6. **Contract / schema / configuration / dependency change**
   - Name the compatibility boundary: API, type, event, database, environment, build, or package.
   - Identify producers and consumers, version skew, defaults, failure mode, and rollback behavior.
   - For schemas and migrations, require a forward-only upgrade path and an upgrade test beginning
     from the preceding released migration set; fresh-install coverage alone is insufficient.
   - For dependency changes, distinguish lockfile-only churn from runtime or build behavior, and
     cite the code path that uses any added or upgraded capability.

7. **Test-only change**
   - State whether coverage is added, tightened, reorganized, or weakened.
   - Map the assertion to the production behavior it proves. A snapshot or assertion rewrite must
     explain why the new expectation is correct.
   - Flag deleted assertions, broader mocks, reduced boundaries, or implementation-coupled tests
     that can pass while user-visible behavior is broken.

8. **Mechanical / generated change**
   - Prove the generating source or deterministic transformation and separate any hand-edited
     semantic changes from the generated churn.
   - Review the source-of-truth change, not every generated line, while checking that generated
     artifacts are complete and no unrelated output changed.

The review output should mirror this reasoning rather than return a generic checklist:

1. **Change inventory:** each unit, its type, its intent, and cited implementation lines.
2. **Evidence tables:** verification maps for new/changed behavior; parity tables for refactors and
   replacements; reachability evidence for deletions.
3. **Findings:** only concrete issues, each labeled Blocking or Non-blocking and anchored to an exact
   changed line whenever possible.
4. **Verdict:** approve or reject based on task fulfillment and blocking findings, plus explicit
   residual uncertainty where evidence was unavailable.

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

### <a id="4"></a>4. Design access gate

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

### <a id="5"></a>5. Never let a server test spawn the real codex/claude CLI

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

### <a id="6"></a>6. When a task is blocked on an exhausted third-party account balance, stop probing and cut the code-level cost driver instead

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

### <a id="7"></a>7. Claude autocompaction accepts `auto` or 100k–1M tokens

On 2026-08-24, setting Workbench's Claude launcher to `--autocompact 50000` made every run fail immediately: the installed Claude CLI only accepts `auto` or a numeric value from 100k through 1M. Keep the runner at `100k` (the minimum numeric setting), with a regression assertion in `agent-runner.test.ts`; never lower it to a bare `50000`.

### <a id="8"></a>8. (always) Never fire billed live-agent eval runs on your own initiative

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

### <a id="9"></a>9. Pluto RAG runtime spend is bounded before dispatch, not merely counted afterward

The 2026-08-24 RAG runaway fix established a separate production invariant from the eval-tier rule:
every `/api/agent-v2` run owns one shared token ledger across the Research Agent, producer rounds, and
model-backed RAG reranking. A model request must reserve a provider-bounded worst case before it is
sent; if that reservation cannot fit, the runtime degrades cleanly without making the call. Successful
calls replace the reservation with actual fresh-input, cache-read, cache-write, and output usage;
failed/cancelled calls release it. Optional reranking skips to deterministic RRF order when its
reservation is refused. Never regress this to a spent-only, post-response counter: that can observe an
overspend but cannot prevent it, and parallel work can pass the same stale headroom check.

### <a id="10"></a>10. Claude cache traffic is a first-class Insight metric

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

### <a id="11"></a>11. Claude stream usage must be deduplicated by provider request

Claude's stream can repeat an `assistant` usage payload once per content block (for example thinking,
text, and tool use) for one actual provider request. Those replicas share `requestId` and message ID.
The runner must count that request once, then sum distinct provider requests; the terminal `result`
remains authoritative and replaces the provisional aggregate. On 2026-08-24, summing every replica
manufactured 1M-token run failures from about 155K tokens of final observed traffic. Any live
budget/cost circuit breaker must run after this deduplication, or it will terminate healthy work based
on presentation duplication instead of provider consumption.

### <a id="12"></a>12. Workbench runs use one context, not a token kill switch

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

### <a id="13"></a>13. Cache-read reduction: dual-agent dispatch stays, other levers are the approved path

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

### <a id="14"></a>14. Codex session accounting: `input_tokens` includes cache reads

On 2026-08-24, Jeffrey's seven-day Codex session-log aggregate reported 637,606,464
`input_tokens`, 619,460,480 `cached_input_tokens`, 0 cache writes, and 1,646,031 output tokens.
For Codex, cached input is a subset of input, not an additional category: this means **18,145,984
fresh input (2.85% of inbound)**, **619,460,480 cache reads (97.15%)**, and **639,252,495 total
traffic**. Never add the first two figures when reporting total traffic or estimating usage. Codex
does not separately report cache writes in these local token-count events; zero is an unavailable
breakdown, not evidence that no cache was written.

### <a id="15"></a>15. Usage calibration is an agent-owned local command, with one provider boundary

On 2026-08-24, Jeffrey asked that usage calibration become an easy command agents can run without
asking him to collect local token totals. `npm run usage:calibrate` is the canonical command: it
reports fresh input, cache read, cache write (when exposed), output, and total traffic over the last
seven days from Claude transcripts and Codex session logs. It may be run with `-- --days N`.

It must fail closed on calibration: Claude's CLI does not expose the authoritative weekly `/usage`
percentage, and Codex app-server percentages describe a short rate-limit window rather than the
ISO-week ceiling. Neither number may be silently recorded as a weekly calibration. Agents own the
ongoing local measurement and should run the command when asked to calibrate; an interactive Claude
`/usage` observation is still required to recalibrate Claude's weekly ceiling.

### <a id="16"></a>16. Commits must never carry an agent Co-Authored-By trailer

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

### <a id="17"></a>17. A dominant activity-log entry can be a bug, not a usage signal — verify before "strengthening" it

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

### <a id="18"></a>18. `.gitignore` directory patterns must be anchored to the repo root

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

### <a id="19"></a>19. The conversation dropdown is the only authority for task category

*Superseded by Jeffrey, 2026-09-08.* Every conversation has a category selected
in its dropdown; there is no unselected state. Workbench must send and persist
that category on every turn and use it unchanged for routing, persona, run kind,
and the chat-bubble label. Claude, Palmyra, Codex, message keywords, and the
turn-grounding supervisor must never reclassify it. For legacy queued messages
that predate a persisted category, use the linked task's stored category or the
dropdown default (`execute`) rather than inferring from prose.

### <a id="20"></a>20. Conversation history is evidence; one resolved turn objective is the instruction source

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

## <a id="21"></a>21. Scoping boundaries in specs are reasons, not bans (2026-09-01)

While refining CON-226 (publishing a generated Connector Gateway client package), I wrote into the
tech spec that the shared package "must not contain React, TanStack Query, Zod, forms, component
props, or view-specific types." Jeffrey rejected the sentence twice — first as "we NEED to use zod
and tanstack", then as "why the fuck not??" — because it reads as a blanket prohibition on tools the
team actually wants, with no stated reason.

The durable rule: when a spec draws a boundary around a shared package or module, state the
constraint and the reason it exists, and separate the parts that are genuinely structural from the
parts that are only sequencing. For this case the defensible split is: UI forms, component props,
and view models stay out because they describe one app's UI rather than the API contract; React and
TanStack Query stay out of the *core* layer only so it is framework-neutral, and belong in an
optional React layer; Zod is not excluded at all — the real constraint is that the two frontends sit
on incompatible Zod majors and the backend response schemas are still too loose to be worth
validating against. A rule Jeffrey cannot trace to a tradeoff will be read as arbitrary and thrown
out, correctly.


## <a id="23"></a>23. Name code with mainstream industry vocabulary, not architectural jargon (2026-08-28)

Jeffrey rejects imported architectural nouns in Writer code and prose when a plainer, more widely
recognized term exists. Specifically he ruled out "projection" and "view model" as names for files,
types, or comments, because they come from MVVM/CQRS vocabulary that neither React nor this codebase
uses, so a reader has to learn a private dialect before reading the code.

Prefer names an ordinary React/TypeScript reader already knows: `selectors.ts` for pure derivation
functions, `useThing` for the hook, and repo-native type suffixes such as `UseThingOptions` and
`UseThingResult` (both already used across `frontend/src`). Name a module after what it produces or
the standard role it plays, and check the surrounding directory for a near-collision before settling
on a filename.

Learned on the Manage Connectors V2 card page, where `projection.ts` and
`useManageConnectorsViewModel` were renamed to `selectors.ts` and `useManageConnectors`.


## <a id="24"></a>24. Look for an existing pattern before writing new behavior

*Instruction from Jeffrey, 2026-08-28.* When adding a capability — a hook, a utility, an interaction
pattern — search the repository for an existing implementation first and extend or mirror it, rather
than writing a fresh one. Jeffrey stated this as a standing expectation ("see if we already have
existing patterns/utils before reinventing the wheel"), not a one-off request, and it applies beyond
the literal "new util" case in the monorepo's `CLAUDE.md`: it covers matching an established idiom
even when no shared module is extracted.

The value is consistency of behavior, not only avoided duplication. Concretely, the accessibility
follow-up on Manage Connectors V2 needed programmatic focus movement; the repo already had
`scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' })` followed by
`element.focus({ preventScroll: true })` on a `tabIndex={-1}` landmark
(`frontend/src/components/agent-insights/agent-insights-page.tsx`,
`.../section-card/section-card.tsx`). Copying that pair kept reduced-motion handling and tab-order
behavior identical across two pages instead of inventing a second convention.


## <a id="25"></a>25. Hard-flag every legacy file a new feature touches

When a feature branch modifies pre-existing ("legacy") code that a new code path shares, Jeffrey
requires the change to be flagged in that legacy file itself — stated on 2026-08-28 as a standing
rule with "no exceptions": "any legacy code that we touch MUST be flagged for the new logic code
paths."

The flag is a greppable ticket-keyed comment (for example `CON-194 LEGACY-AFFECTING:`) placed at each
changed site, plus a short block at the top of the component or hook explaining what changed for the
pre-existing callers and why the change was shared rather than gated on the new caller. Distinguish
edits that change behavior for existing consumers from purely additive ones that no existing caller
reads.

The reason is reviewability and blast radius: a reader opening a legacy component months later must
be able to see immediately that a newer feature altered its runtime behavior, instead of assuming the
file is untouched. Choosing to share a fix with the legacy path (rather than gating it) is allowed —
Jeffrey accepted that for `connect-connector-modal.tsx` — but only if the sharing is documented in
place.


## <a id="26"></a>26. Feature-flag gates must never fall through to legacy while flags resolve (2026-08-31)

Jeffrey, on Connectors V2: seeing the legacy skeleton render before the V2 skeleton is "unacceptable".
A gate that reads `useFeatureFlag(...)` alone treats "not resolved yet" as `false`, so every V2 user
briefly mounts the legacy view — running its queries and flashing a layout V2 never shows. Gate on
flag readiness as a third `pending` state that renders the new view's own skeleton, and route every
render site that paints before the gated component (page-level tab skeletons included) through the
same hook so they cannot disagree.


## <a id="27"></a>27. Every failed user-triggered mutation must raise an error toast

Jeffrey's standing rule (2026-08-31), stated after a failed connector-profile revoke returned
silently: a user action that fails MUST tell the user it failed. Silence is never acceptable, and
"the failure is visible because the list did not change" is not a substitute for a toast.

The trap is a multi-step action where only some steps report. Helpers that signal failure by
resolving `false` or returning a `{ status: 'error' }` result — rather than throwing — raise no
toast of their own, and this repo registers no global React Query `MutationCache` `onError`, so a
mutation failure is reported only where a caller handles it explicitly. Before assuming an
upstream layer toasts, read it: confirm each failure path either raises its own toast or is
toasted by the caller.

Balance that against double-toasting: when the inner hook already calls `handleApiError` with a
toast, the caller must stay silent for that path. Assert both directions in tests — the path that
must toast, and the path that must delegate.


## <a id="28"></a>28. Design answers must cover the asset/data lifecycle, not just the code shape (2026-08-31)

When Jeffrey asks "what options do we have" for something that depends on data or assets owned
outside the repo, an answer scoped to in-repo types, refactors, and call sites is not an answer.
On the connector-logo question he rejected a proposal built around a typed `ConnectorLogoRef`
union and unified render props with: "this is only solving it from a code perspective... what
happens when external logos get updated? or source images get moved? we need a single unified
method for both retrieving AND rendering."

The lesson generalizes past logos. For anything sourced from a third party or from object storage,
the design must say what happens when the upstream artifact changes, moves, 404s, or expires — who
re-fetches it, on what cadence, where the durable copy lives, how a version change propagates to
clients and caches, and what renders when every source fails. Treat retrieval and rendering as one
mechanism with one owner; a type union at the boundary is an implementation detail of that
mechanism, never a substitute for it.


## <a id="29"></a>29. One selector, not a comparison builder (2026-09-01)

When a Workbench review surface browses committed history, Jeffrey wants a **single commit selector**
and nothing else. Each commit is shown against the one immediately before it. He rejected a repo
browser that shipped two dropdowns — a branch/worktree picker plus a commit picker whose default was
"whole branch vs base" — with "no one asked for it", because it turned reading a commit into
configuring a comparison.

The general rule this instance carries: do not invent a comparison base, a second axis, or an extra
control the request did not ask for. Pick the obvious default (the previous commit, the newest
commit) and expose one control. If a second dimension seems genuinely necessary, ask before building
it rather than shipping it and explaining it afterwards.


## <a id="30"></a>30. Feature-flagged backend changes: one entrypoint, no second evaluation (2026-09-02)

When a backend change exists to serve a frontend feature that is already behind a rollout gate,
Jeffrey's standing requirement is to "absolutely minimize blast radius and only have one single
flagged entrypoint". The gate is evaluated once, on the client. The server must not evaluate the
same gate a second time; it takes an explicit request parameter and honours it.

This was learned the hard way on CON-218. The Connector Gateway `GET /profiles` handler evaluated
the same `actionagentmanageconnectorsv2` Statsig gate the browser evaluates, to decide whether
`query` should also match the connector's catalog name. One boolean evaluated in two services is two
answers: the browser said on and deleted its client-side filter, while the gateway said off, because
its Statsig client returns the supplied default whenever the SDK cannot initialise — which is every
environment with no `STATSIG_API_KEY`, including local. Search then fell back to matching only the
operator-chosen profile label and returned nothing. A server-side gate also changes behaviour for
every other caller of a shared endpoint the moment it flips, whereas an explicit parameter confines
the change to the one caller that sends it, by construction rather than by gate configuration.

The related rule, from the same review: do not widen a search to fields the user cannot see. Adding
a `description ILIKE` predicate alongside the requested connector-name matching was unrequested scope
that returns cards whose visible text has nothing to do with the term. Match what the card shows or
is identified by, and nothing else.

**"One entrypoint" is literal, and stricter than it first sounds (2026-09-02).** A first attempt at
CON-218 satisfied "no second flag evaluation" but still threaded an `unifiedCardList` field through
the existing args type and branched on it in three places inside the existing model — extracting a
helper, parameterising the search clause, and adding an `if` in the `orderBy` callback. Jeffrey
rejected that outright. What he wants, in his own pseudocode, is:

```
// in the same route
if (flag on)  -> do new shit
if (flag off) -> do old shit
```

and "THAT IS IT, THAT'S THE ONLY CHANGE I WANT TO SEE IN EXISTING LOGIC. EVERYTHING ELSE NEEDS TO
LIVE IN NEW LOGIC." Concretely: the branch goes at the outermost handler, the off-path stays
byte-identical to `main`, and the whole new behaviour lives in a new module that no existing caller
imports. Existing types, models, services, and orchestration are not modified, not parameterised, and
not refactored "while we're here" — a diff against `main` that shows deletions in existing files has
already failed the rule. Duplicating query-building code into the new module is the accepted cost;
removing the feature must be deleting one directory and one `if`. The reshaped CON-218 commit is the
reference: three new files plus a 29-line route branch, zero deletions.


## <a id="31"></a>31. A rewrite preserves the legacy behavior exactly — do not "improve" the UX along the way (2026-09-08)

During the Manage Connectors V2 work, the V2 connect flow added a deliberate behavior the legacy flow
never had: after a successful OAuth connection it held `ConnectConnectorModal` open on a
"Successfully Connected!" state until the user dismissed it, on the reasoning that a modal closing by
itself gives no confirmation. Jeffrey rejected that twice, the second time as "the modal is still
fucking open after OAUTH connection", and stated the rule directly: "these are regressions including
the autoclosing modal. we need to maintain the legacy behavior EXACTLY."

The standing rule for any V1 → V2 rewrite or refactor he asks for: the new implementation reproduces
the old observable behavior, including behavior that looks like a flaw. A behavior change is a
separate, explicitly requested piece of work. Reasoning that the new behavior is better is not a
license to ship it inside a refactor, and describing it in a code comment does not make it agreed.


## <a id="32"></a>32. When new code breaks existing machinery, delete the deviation — do not patch the symptom (2026-09-08)

Continuing the Manage Connectors V2 connect flow, the V2 modal sat stuck on "connecting" after OAuth.
Successive attempts chased the symptom: cutting a cache entry, adding a popup-closed grace period,
adding window-closed detection — each one touching more shared files (`connect-connector-modal.tsx`,
`oauth-popup.ts`, `use-github-oauth.ts`, the legacy `use-connector-auth.ts`). Jeffrey rejected the
whole approach twice, the second time as: "STOP TRYING TO PATCH THE FUCKING PROBLEM. SOLVE FROM FIRST
PRINCIPLES. WE HAVE A CONNECTOR MODAL COMPONENT THAT EXISTS. WE HAVE OAUTH FLOW LOGIC THAT EXISTS...
ALL WE HAVE TO DO IS CORRECTLY ADAPT OUR V2 STATE TO THE EXISTING FUCKING MODAL."

He was right, and the shape of the answer generalizes. When a working, shared component misbehaves
only under a new feature, the defect is almost always something the new code added to a path it
shares with everyone else — a flag-driven cache injected into a shared fetcher, or a local state
layer wrapped around a hook that already owned that state. The fix is to remove the new code's
deviation so the existing logic runs unmodified, and it should read as a deletion. Here it was
−86 lines across 6 files, with the modal and OAuth helpers untouched.

The standing rule: before editing shared code to accommodate a new surface, diff the new surface's
behavior against the old one on that shared path and ask what the new code added. Growing the patch
across more shared files is the signal that the diagnosis is wrong, not that the bug is deep.

Restated by Jeffrey on the next iteration, as a concrete ownership boundary for Connectors: the
`ConnectConnectorModal` owns its own open/authorizing/success/error state and that legacy behavior is
not to be touched. Manage Connectors V2's only job is to wire its own success and error states
through to the modal via the existing props — never to hold the modal open, override `open` or
`connectorConfig`, or intercept `onOpenChange`. The V2-side success effects (toast, autoscroll,
cache refresh) hang off `onAuthenticated`; the error surface stays the modal's.


## <a id="33"></a>33. Keep code comments short; do not pre-argue review objections in them (2026-09-09)

Jeffrey has twice cut back block comments in the CON-230 connectors-v2 code, the second time with
"why is this comment so fucking long". The pattern he objects to is a comment that stops describing
what the code does and starts defending why an alternative was rejected — an anticipated reviewer
question answered inline, in the file, forever.

The rule: a comment carries only the one non-obvious fact a reader needs to understand the code in
front of them, in two or three lines. Design justification, rejected alternatives, and rationale for
where a call lives belong in the PR description or the review thread, which is where the objection
would actually be raised and where it expires once resolved. If a comment is growing a second
paragraph that begins "deliberately" or "instead", that paragraph is review argument, not
documentation, and should be deleted.


## <a id="34"></a>34. The Pluto bench bills production Claude API credits (2026-09-10)

Jeffrey, escalating mid-task: the last few `scripts/run-bench.cjs` runs "quite literally exhausted the
production Claude API credits." The bench is not a free local harness — it drives the real agent against
the real Anthropic API on the production key, so every sweep is real money out of the product's budget.

Never launch a bench sweep as a casual verification step, and never re-run one just to confirm a result
that already has a log. Before proposing a run, state its expected cost and prefer the cheapest tier that
answers the question (`--tier retrieval` spends $0 model tokens; `--ids <case>` scopes to specific cases).
Treat a full multi-turn sweep as an explicit, budgeted decision that is Jeffrey's to make, not an
implementation detail of a debugging loop.

Measured cost lives in Supabase `token_usage` and `/tmp/agent-v2-usage.log`; `node scripts/cost-report.cjs
--bench-run <log>` prices a specific run. The bench's own result files record no token data at all, which
is why the spend stayed invisible until the credits ran out.


## <a id="35"></a>35. Prototypes are built in the real application, not in Storybook

On 2026-09-11, after a connector error-UX plan proposed a Storybook-only prototype, Jeffrey rejected
it outright and restated the requirement: cut a branch in the monorepo and build the prototype in the
actual product code.

When Jeffrey asks for a prototype, the deliverable is working code on a branch in the owning
repository, wired into the real components, data model, and state layer the feature already uses. A
Storybook story, a standalone demo page, an HTML mock, or any other external prototyping tool does not
satisfy the request, because the point of the prototype is to demo the real experience to the team for
buy-in — something a component gallery detached from the app's data cannot do.

Base the branch on whatever in-flight branch the prototype depends on rather than on `main`, so the
demo includes the plumbing it builds upon.


## <a id="36"></a>36. Verify the server's contract before shipping a client-side validation change

On 2026-09-14, during CON-270, the "blank HTTP Basic password" fix was implemented in two frontend
repos — relaxing the forms so the username was mandatory and the password optional — and reported as
done. Jeffrey's reply: "did you fucking verify that username mandatory, password optional is what
be.mcp-gateway expects??" It was not. Reading `be.mcp-gateway` showed the connect route declared
`password: t.String({ minLength: 1 })`, so every relaxed form would have traded a client-side
"Password is required" message for a server-side 422.

Whenever a change loosens, tightens, or reshapes what a client sends, read the receiving service's
schema, handler, and storage format first, and quote the exact file and line. A validation rule is
one end of a contract; changing one end without reading the other is not a fix, it just relocates the
error. The same sweep must continue past the request boundary — in this case the credential was also
persisted in a format whose reader silently dropped a blank password, a second failure that a
route-only check would have missed.


## <a id="37"></a>37. Regenerate generated API clients; never hand-write their types

When frontend work needs new backend fields, regenerate the typed client with the repo's own
OpenAPI codegen command instead of hand-authoring the request/response types. Jeffrey stated this
directly on 2026-09-15 for the AIS password-grant work: "there should be an openai ts command to
auto generate the client. use it."

In `~/dev/fe.web-app`, that command is `pnpm generate:connect-gateway`, run from
`apps/service.writer-app`. It wipes `src/generated/connector-gateway` and runs `@hey-api/openapi-ts`
via `src/generated/generate-connector-gateway.ts`, using `openapi-ts.config.ts`, which reads a local
`connector-gateway.yaml` if present and otherwise fetches
`https://app.qordobadev.com/api/mcp-gateway/swagger/json` with a `Q_TOKEN` env var.

The one legitimate reason to write types by hand is hey-api's literal collapse: it emits discriminator
fields as `kind: string` / `mode: string`, so generated unions cannot be narrowed. The codebase's
established response is a small hand-patched literal union layered over the generated type (see
`DetectedAuth` in `create-custom-connector/api/byo.queries.ts`), not a hand-written client.


## <a id="38"></a>38. Contract tests must be derived from the backend, not restate the audit

When an audit concludes "the frontend matches what the backend expects", Jeffrey wants that
conclusion enforced by tests rather than asserted in prose. On 2026-09-16, during the AIS
password-grant work, he said: "what i need is unit tests for this logic. we need to guarantee that
your audit - ie what the backend expects - matches the frontend permutation EXACTLY."

The weak form he is rejecting is a test that restates the finding as a literal, such as
`expect([...OPENAPI_AUTH_TYPES_WITH_CUSTOM_HEADERS]).toEqual([AUTH_TYPE.OAUTH2, AUTH_TYPE.PASSWORD])`.
That passes forever and drifts silently the moment the backend changes. The strong form drives the
real mapper over every reachable permutation and checks the emitted payload against a contract table
that is itself pinned to the generated client, so regenerating the client after a backend change
fails the suite instead of shipping a 400.

Two related traps. First, the backend source of truth is `origin/main`, not whatever branch happens
to be checked out locally: the `be.mcp-gateway` working copy was eight days stale and was missing an
entire auth variant, which made an earlier audit wrong. Second, when a contract test surfaces a real
defect, leave it failing and report it rather than weakening the assertion to keep the suite green.


## <a id="39"></a>39. Client types come from the OpenAPI generator, never hand-written or hand-widened

Jeffrey's standing rule for frontend work against the Writer gateways: get client types from the
OpenAPI type generation, not from hand-authored interfaces or by widening a generated union in
place. He restated it mid-task on 2026-09-16 during the CON-274 Writer Agent password-grant work —
"also use the openapi types generation for the client" — while an implementation was considering
adding a `password` member to the generated `securityScheme` union by hand.

In practice this means deriving request and response shapes from the generated module
(`@/generated/mcp-gateway` in `writer-monorepo/frontend`, regenerated by `pnpm sync:mcp-gateway`,
configured in `frontend/openapi-ts.config.ts`, which fetches the live swagger and needs a `Q_TOKEN`
or `DEV_AUTH_TOKEN`). Extract the variant you need from the generated union rather than retyping it,
for example `Extract<PostApi...ConnectData['body'], { password: string }>`.

The rule also has a diagnostic use. If a value genuinely cannot be expressed in the generated types,
that usually means it belongs to a different vocabulary rather than that the generated type is
wrong. In the password-grant case the legacy mcp-gateway `SecurityScheme` enum has no password
member and never will, because the password grant is a Connector Gateway concept carried on
`authMode`. Editing the generated file would have hidden that distinction; reading the generated
types as authoritative surfaced it.


## <a id="40"></a>40. Do not wrap a trivial expression in a named helper function

Write the condition inline when the helper body is a single expression that any reader already
understands. A named wrapper around something like an emptiness check adds a definition, a jump, and
a second name for a thing that has an obvious literal spelling — it costs readability instead of
buying it. Reserve extracted helpers for logic that is genuinely non-obvious, repeated in a
meaningfully complex form, or needs a name to explain a business rule.

Corrected on 2026-09-17 during CON-274 (frontend password grant). The modal had
`function isSubmittableCredential(raw: string): boolean { return raw.trim().length > 0; }` used twice
in one line; Jeffrey's response was "what the fuck is this". It was inlined to
`username.trim() !== '' && password.trim() !== '' && !isPending`.


## <a id="41"></a>41. A scope-narrowing order does not authorize deleting load-bearing code

When Jeffrey narrows a diff — "no non-connector-gateway changes", "remove all of it" — he is
excluding changes that *spread* the feature into surfaces he did not ask for. He is not asking to
delete code the feature needs to run. Before reverting any file under such an order, establish what
that file's change actually does: if removing it breaks a contract, a validation boundary, or the
happy path, it belongs in the diff and the right move is to keep it and say why it is in scope.

Corrected on 2026-09-18 during CON-274 (frontend password grant). An earlier turn read "NO V1 OR
LEGACY SHIT AT ALL. REMOVE ALL OF IT" as covering
`backend/mcp_gateway/mcp_gateway_client.py`, and reverted it along with the genuinely out-of-scope
legacy-table and shared-`utils.ts` edits. Jeffrey's response: "what the fuck??? this is absolutely
necessary or it breaks the connector registry validation????" He was right. That file is the
monorepo's *Connector Gateway* client, not a legacy surface: `CgConnectionOrgProfile.auth_mode` is a
strict Pydantic `Literal` and `CgV1TeamConnectionsResponse.model_validate()` parses a whole page at
once, so one org profile with `authMode: "password"` raises `ValidationError` for the entire
connector list rather than skipping that row.

The generalizable test is whether a file sits on the feature's own path or on a neighbouring surface
the feature was pushed into. "Backend file" and "Python file" are not the boundary; "not the thing
Jeffrey asked to build" is.


## <a id="42"></a>42. Streaming client tests must mock the socket progress channel

*Confirmed 2026-10-08.* `requestStream()` sends `application.command` through
`socketTransport.request`, not the fetch-backed Vitest adapter used by ordinary
`request()` calls. Tests for streamed UI must mock that transport and emit SSE
frames through `options.onProgress`; fetch mocks alone leave the mutation pending
and falsely make rendered answers and errors disappear. Keep the normal fetch
mock for cache lookups and other non-stream application requests.

### <a id="43"></a>43. Keep agent-session Unix sockets on the OS temporary path

Agent-session E2E databases and event logs can live inside the task worktree, but do not override `TMPDIR` to a long worktree path. `agent-session.ts` deliberately places `wb-session-*.sock` under `os.tmpdir()` because Unix socket paths are length-limited; forcing the socket into a nested Workbench worktree produced `listen EINVAL` before the host could write events. Keep the database snapshot and `WORKBENCH_AGENT_SESSIONS_DIR` in the worktree while leaving the socket on the normal short OS temporary path.

*Provenance: a5071a94-6704-49d5-af37-419007a98029*
