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

