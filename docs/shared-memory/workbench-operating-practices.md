tier: workbench
## <a id="33"></a>33. Workbench operating practices

### <a id="1"></a>1. Code changes always use worktrees under ~/dev **(always)**

Jeffrey's standing rule from 2026-09-21: every local code change must be created in a dedicated Git
worktree under `~/dev`, never in a repository's primary checkout. This applies to direct Codex/Claude
work and Workbench-dispatched mutating runs. Multi-repository work gets one `~/dev` worktree per
repository; the rule must not collapse a full-stack task to one checkout. Read-only analysis and
review may inspect primary checkouts because they do not write code.

*Correction from Jeffrey, 2026-09-22.* "Use a worktree" does not mean "create a new worktree per
turn." Before allocating anything, resolve the target ticket/branch against `git worktree list` and
reuse its existing live `~/dev` worktree. A follow-up run stays on that branch and uses the workspace
lease for write serialization. Hidden detached run worktrees are only a fallback when the repository
has no existing task worktree; they must never fork an already-checked-out feature branch.

### <a id="2"></a>2. Local documents have one physical root **(always)**

All personal, generated, imported, meeting, research, and durable-knowledge documents live under
`~/Documents/Workbench`. `~/notes` is a compatibility symlink to the canonical `notes` directory,
not a second store. Repository-owned documentation stays checked into its repository.

### <a id="3"></a>3. Workspace resolution is authoritative for task execution (2026-08-29)

Jeffrey explicitly disabled every guard that requires a task to have an internal or external
repository. A task may run with no `project_name`, no linked workspace, or an explicit non-Git scratch
directory. Workspace resolution provides a process working directory; it is not a prerequisite and
does not prove that the task belongs to that repository. Missing project or repository metadata must
never block agent execution. Agents must still avoid editing an unrelated repository merely because
it is their process working directory.

### <a id="4"></a>4. Keep workbench executions short

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

Workbench agent turns have a 30-minute hard timeout. Estimate and report whether a
foreground backfill or verification fits inside that window before starting it; split
or checkpoint work that does not.

### <a id="5"></a>5. Reuse active coding-agent sessions where safe

Jeffrey identified process-per-request agent startup as a material coding-workflow
latency problem (2026-08-25). Workbench should retain a safe continuation path for
an active coding conversation or task instead of treating every follow-up as an
unrelated fresh instance. Any design must preserve durable shared context, workspace
leases, cancellation, provider/account isolation, and a restart fallback; ephemeral
agents remain appropriate for independent research, review, and fan-out work.

**Resolved implementation gap, 2026-08-26:** ordinary shared-room conversation
turns now retain provider-specific conversation anchors. Codex starts one
non-ephemeral app-server thread per conversation and later uses `thread/resume`
with its durable `codexThreadId`; Claude receives that conversation's stored
`claudeSessionId` through `--resume`. Provider switching remains deliberately
isolated: each provider resumes only its own prior context, never the other
provider's. This is covered by focused unit and migration tests; end-to-end
startup-latency measurement remains required before claiming a quantified speedup.

### <a id="6"></a>6. Workbench improvement suggestions scope

*When asked to find Workbench improvements, stick to user-facing UX and never resuggest filters/saved views*

When Jeffrey asks to find more improvements for Workbench (the internal tool), scope suggestions to
genuine user-facing UX friction — how the UI behaves, feels, and responds in the moment (loading
states, error feedback, mobile tap targets, confirmation dialogs, dead-end states). He does not want
backend/infra/admin tooling suggestions (e.g. database backup-and-restore UI, audit-log/ops
dashboards) framed as "improvements" — those read as "backend shit" to him even when well-evidenced.

He has permanently rejected "add a filter" and "add saved views" as improvement ideas. Do not
resuggest either, in any phrasing, in future improvement-finding sessions — he has said this more
than once and it should not come up again.

The pattern worth reusing — backend already has the data/logic fully built, only the UI surface is
missing — is a good class of finding for this kind of request, distinct from proposing new backend
capability from scratch. Cost metrics are explicitly excluded; Workbench tracks token usage instead.

### <a id="7"></a>7. Markdown written by runs is published automatically

*Markdown a run writes under `docs/` or `~/Documents/Workbench/` lands in the artifact library on its own*

When a run completes, Workbench publishes every `.md` file the run wrote under `docs/` of its
worktree, or anywhere under `~/Documents/Workbench/`, and links it to the run's task. Files in
`node_modules` or test fixtures are skipped. Unchanged content is a no-op, and each new version
adds an activity entry on the task (`src/server/run-artifact-publish.ts`). Nothing needs to be
published by hand; `POST /api/artifacts/publish` and the Share button remain for other files.

### <a id="8"></a>8. Pluto timesheets always total 10 hours

Every Pluto weekly timesheet must contain enough distinct task lines to total exactly 10.0 hours.
At the current $150 hourly rate, the subtotal, amount due, and total due must each be $1,500.00.
Verify the task-row quantity sum mechanically before publishing; a shorter total or an overly
compressed task breakdown is incomplete.

### <a id="9"></a>9. Coordinate file writes across agents

*When multiple agents write to the same file path, explicit handoff is required before the second write*

When a task involves file output and multiple agents are active, one must complete and report done before the next begins writing to the same path. Otherwise the second write silently overwrites the first, and you cannot recover which version is correct without checking git history or examining both agent transcripts independently.

**The specific failure:** Codex created and committed `docs/proposals/manage-connectors-v2.html` using the monorepo proposal skill. Jeffrey then asked "why did you stop? continue," which I interpreted as a prompt to keep working. I independently began creating the same file to the same path without first confirming that the file was complete or that Codex had finished. Whichever write ran last won, and the earlier version was lost.

**Prevention:** Before writing to a file that may have been touched by another agent, check git status and read the file to verify whether the task is actually complete. If it is, say so. Do not continue working on the same output path independently.

**Source files under active refactor are not exempt.** During a long-running repository.ts extraction (2026-08-24), Codex saved concurrent, unrelated edits (a new `StatusTransitionContext` parameter, bulk-update logic) to the exact file Claude was mid-edit on, live, with no coordination. A `vitest run` executed at the instant Codex's write landed on disk caught the file mid-save and failed with a spurious `cannot start a transaction within a transaction` error in code neither agent had touched that turn; the identical run seconds later, once the write settled, passed clean. Treat a test failure that implicates code you did not touch as a possible read of a concurrently-written file before assuming it is real: re-run once, and only trust the result if `git diff` is stable (no shared file is actively changing) across the two runs.

### <a id="10"></a>10. Workbench runtime ports

Workbench must not claim Writer or Pluto development ports. Jeffrey's explicit allocation is:

- Writer/Pluto keep their normal development ports.
- Workbench's stable gateway and ngrok target use `5180`.
- Workbench's review preview uses `5181`.

When changing this allocation, update the preview command, the supervisor-managed process, and
user-facing runtime references together. Do not redirect Writer or Pluto as a workaround.

The stable gateway port is `5180` everywhere Workbench emits or consumes a runtime URL: promotion
health checks, supervisor defaults, share defaults, app-origin defaults, MCP configuration, agent
prompts, docs, and tests. Do not reintroduce the separate local development service's port into
Workbench configuration.

### <a id="11"></a>11. Phone preview through the separate project ngrok hostname

`https://broiling-recoil-grouped.ngrok-free.dev` is Workbench-only and stays on `5180`.
`https://blahblahblah.ngrok.app/` is the separate Writer/Pluto phone-preview hostname. Workbench's
`npm run share -- <local-url>` command controls that preview hostname and forwards it to exactly one
already-running requested project. Do not put a share command in either project or repoint Workbench's
hostname.

Vite dev servers reject the public ngrok `Host` header by default. The Workbench share command must
rewrite that request header to the local target host; otherwise the tunnel is connected but every
phone request returns Vite's 403 "host is not allowed" page. Verify the public URL returns HTTP 200
before handing off a phone preview.

Some local Vite instances bind only the IPv6 loopback address. The Workbench-only share command must
fall back from an explicit `127.0.0.1` target to `localhost` when that target is otherwise healthy;
do not report that a project is down merely because IPv4 is unavailable. Verified 2026-08-24.

### <a id="12"></a>12. Always close dev servers **(always)**

*Always shut down dev servers before finishing; they interfere with Jeffrey's local environment*

Always shut down any dev servers you start (Next.js, Vite, Storybook, etc.) before finishing work or leaving the agent to run independently. Lingering server instances interfere with Jeffrey's local environment and break his workflow.

#### Application

- After testing or development work, explicitly kill the server process
- When asking Jeffrey to test something, include the shutdown in the verification steps
- If you start a server, you are responsible for cleaning it up — don't assume Jeffrey will do it or that it will exit naturally
- This applies whether the server is running in the foreground or background


### <a id="13"></a>13. Jeffrey uses the running app — never revert his state **(always)**

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

### <a id="14"></a>14. Jeffrey's stack working model

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

**Dual-agent dispatch is a product requirement.** Jeffrey explicitly rejected using fewer
simultaneous agents as a token-reduction lever: the ability to collaborate with both Claude and
Codex in one shared room is what differentiates Workbench. Keep the concurrent-recipient path;
reduce cache traffic through bounded retrieval/history, compact prompts, and fewer avoidable
round-trips within each agent instead.

**Shared context is mandatory; budgeting must preserve it.** Jeffrey clarified on 2026-08-24 that
shared context is Workbench's most critical requirement, not a feature that can be traded away to
control model usage. Context controls must therefore retain durable shared facts and make them
available to every agent: constrain each run's transient prompt, retrieve the smallest relevant
shared-memory evidence automatically, and persist useful outcomes back to the shared store. Never
solve cost or token overruns by creating agent-private context, withholding shared context, or
discarding durable history.

### <a id="15"></a>15. Retrieval is adaptive, and compaction preserves key points

*Decision from Jeffrey, 2026-08-25.* A room or task prompt may retrieve at
most eight candidates; eight is a ceiling, not an injection target. Inject
only relevant, non-duplicative evidence that clears the query-relative score
threshold and fits the prompt budget. A complete latest user question must
query on its own: do not append an unrelated previous control turn and dilute
the retrieval terms. Only a context-dependent shorthand follow-up (for example,
"Yes, do it") inherits the preceding user turn. Before prompt injection,
summarize/compact long shared briefs and conversation history around durable
decisions, blockers, evidence, and current requests; raw head/tail truncation
alone loses the useful middle.

Self-contained implementation and review turns do not run durable retrieval by
default. Retrieval is automatic for research, strategy, bug-fix, explicit-memory,
and historically dependent turns, and the complete injected memory block is
capped at 4,000 characters. Full-conversation constraints are sent to the
turn-grounding supervisor only when the newest message signals a correction or
repeated failure, with a 900-character cap. The cascade breaker likewise appears
only when the newest Jeffrey message repeats an earlier directive; it must not
linger on unrelated future turns. Static execution-fidelity rules live in the
provider's cold-start/system context and are not replayed into resumed turns.
These prompt-cost boundaries are part of the failure-prevention design: do not
trade cascading-agent protection for recurring fresh-input spend.

A response that asks Jeffrey for inspectable evidence without any recorded
investigation is not accepted as a completed turn; Workbench automatically
retries it with an evidence-first recovery instruction. The same terminal
rejection runs in the standalone task harness, so leaving the shared room cannot
bypass these controls.

### <a id="16"></a>16. Automate it; don't add a button **(always)**

Jeffrey pushed back on a "Sync" button that required clicking to pull fresh data: "i don't want a
manual sync process, that is tedious."

Default to automatic background behavior rather than a user-triggered action. A polling loop, a
watcher, or a scheduled refresh is the expected design; a button the user must remember to press is a
design smell to him even when it is simpler to build. Keep a manual trigger only as a secondary
affordance for forcing an immediate refresh, never as the primary path.

The same instinct extends to configuration: he asked to *choose* scope once (Linear teams and
projects) and then have the system keep itself current. Prefer designs where the user expresses intent
once and the tool maintains state from then on.

### <a id="17"></a>17. Never make Jeffrey retype an identifier, and never let it fork into variants **(always)**

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
### <a id="18"></a>18. Claude account switching

Jeffrey wants to be able to switch between separately authenticated Claude accounts during
Workbench use. The supported design is named, isolated Claude profiles: Workbench stores and
selects a profile identifier, while each profile owns a separate CLI credential/config directory.
The selected profile must not weaken shared-context injection, subprocess secret filtering, or the
hard per-run token/cost budget. Do not implement this by copying tokens into Workbench settings or
by relying on an undocumented Claude CLI environment variable; the one-time account login and the
credential-directory mechanism must be verified against the installed Claude CLI first.

### <a id="19"></a>19. Verify "already implemented" claims against files, not just memory

A prior-session summary said a feature (the /usage calibration UI) was "implemented and verified."
Reading the actual file showed only the server half existed — the client input form and history view
were never written. The summary was half-true, and treating it as settled would have shipped a task
half-done.

Retrieved memory (compacted summaries, shared-memory notes, prior-session claims) records what was
believed true at write time, not a live snapshot. Before continuing work that memory says is already
done, `Read` the file(s) it names and confirm the claimed code is actually there. Only after that
confirms it, trust the memory for the *reasoning* behind the earlier decisions.

### <a id="20"></a>20. Isolate pre-existing failures with a stash round-trip before reporting verification results

On a branch with substantial unrelated in-flight work, `npm run typecheck`/`npm test` can fail for
reasons that have nothing to do with the change just made. Before writing "not clean" (or worse,
silently attributing someone else's failure to your own diff), `git stash` everything, re-run the
check, then `git stash pop`. If the same failures appear with the change fully removed, they predate
it and are out of scope — say so explicitly rather than blurring "my change is clean" with "the
branch is clean."

### <a id="21"></a>21. Runtime promotions auto-commit and push the working tree (always)

Jeffrey's standing instruction (2026-08-24): every runtime promotion must automatically `git add -A`,
commit, and push the working tree in the background once the build succeeds — he does not want to
separately ask for a commit/push after each promotion. This is implemented in
`src/server/runtime-promotion.ts` (`commitAndPushAfterPromotion`, called from `promoteRuntime` after a
successful build). Push failures are reported via the promotion's progress messages but must never
fail the promotion itself — the runtime has already switched by that point. If you touch the promotion
flow, keep this behavior intact.

### <a id="22"></a>22. "Executed task isn't promoted to in progress" can be workspace-lease queueing, not a promotion bug

`MAX_CONCURRENT_RUNS` (default 6, `src/server/scheduler.ts`) is a global run-count ceiling, but it is
not the real concurrency limit for `execute`-kind runs against the same repo. `MUTATING_RUN_KINDS`
(`src/server/agent-runner.ts`) serializes every `execute` run on `repository.claimWorkspace(workspace,
...)` — two `execute` runs whose `resolvedWorkspace` resolves to the same path (e.g. two tasks both
targeting `/Users/jeffrey.lu/dev/workbench`) cannot run concurrently no matter how high the global
ceiling is. A newly executed task's run sits `queued`, and its work item stays `ready`, until the
in-flight run on that same workspace finishes — this can take several minutes and is indistinguishable
in the UI from a broken in-progress promotion. Verified 2026-08-25: work item `739b19f6`'s run was
created at `00:43:56.766Z` but did not start (and the item did not flip to `in_progress`) until
`00:48:54.521Z`, exactly when the other run on the same workspace (`63340c54`) completed. Before
diagnosing a "task not promoted" report as a realtime/status-flip bug, check whether another `execute`
run already holds the lease on the same `resolvedWorkspace` — if so, the task is correctly queued, not
stuck.

### <a id="23"></a>23. Missing index on `shared_messages(conversation_id, ...)` can freeze the whole UI, not just one component

Jeffrey reported (2026-08-25): "when i click send in a convo, the whole UI freezes for a second or
more." `withConversationState()` in `src/server/repository.ts` runs four per-conversation SQL queries
on every `listConversations()` call, and `listConversations()` fires repeatedly per Send — once from
the conversation rail's poll, again from `dispatchNextSharedTurn`, again from `settleLinkedTask`. One
of the four queries (the "latest agent status" lookup: `... WHERE conversation_id = ? AND author IN
('codex','claude') ORDER BY created_at DESC ... LIMIT 1`) had no supporting index, so SQLite did a full
`SCAN shared_messages` plus a temp B-tree sort per conversation. Because this codebase uses
`node:sqlite`'s `DatabaseSync`, that scan runs synchronously on Node's single event loop — it blocks
*every* concurrent request, not just the one that triggered it, which is why the symptom looked like a
global UI freeze rather than a slow Send button.

Measured against a copy of the live db (319 conversations, 3,727 `shared_messages` rows): 226ms for
the full per-request loop before the fix. Fixed with a new forward-only migration,
`040_shared_messages_conversation_author_created_index` in `src/server/database.ts`, adding a composite
index `shared_messages(conversation_id, author, created_at DESC)` — same query plan afterward shows
`SEARCH ... USING INDEX` instead of `SCAN`, and the same loop dropped to 4ms (~55x).

General lesson: when a symptom is described as affecting "the whole UI" rather than one component,
suspect a synchronous, unindexed query on a hot path (anything reachable from polling or Send) rather
than a client-side rendering or state issue — Node's single-threaded event loop means any blocking
server-side scan presents as a global freeze. `EXPLAIN QUERY PLAN` against a copy of the live db is the
fastest way to confirm `SCAN` vs `SEARCH` before writing a fix.

### <a id="24"></a>24. An orphaned queued `shared_messages` row from a disposable e2e test conversation blocked every runtime promotion

Jeffrey reported (2026-08-25): "regression: preview promotions are fucking blocked." All new
`promote_runtime` calls returned "Promotion queued. It will build once active agent work reaches a
durable terminal state." and every conversation stayed stuck at `waiting_promotion` — five or more
of them. The actual promotion job (`shared_messages.dispatch_target = 'promotion'`) was not dead: its
lease (`lease_expires_at`) kept renewing, proving the worker process was alive and looping inside
`waitForPromotionSlot()` in `src/server/orchestrator.ts`, which only exits once
`repository.hasLiveWork()` returns false. `hasLiveWork()` counts any `agent_runs` or `shared_messages`
row with `status IN ('queued', 'running')` where `author IN ('codex', 'claude')` — with no timeout, so
one permanently-queued row blocks it forever.

The culprit was a message in a conversation explicitly titled `[test] overlap repro - safe to delete`
(created by `e2e/streaming-overlap-repro.spec.ts`-style tooling): `author: 'claude'`,
`dispatch_target: 'codex'`, `status: 'queued'`, body literally instructing the agent to "stay running
for a while" to simulate a long streaming turn. It was created but never dispatched/claimed, so it sat
`queued` indefinitely — with no other agent activity, `hasLiveWork()` never went false, so the one
promotion holding the lease could never proceed past the wait, and every later promotion queued behind
it.

Immediate recovery: `cancel_conversation_message` on the stuck row flips it to `canceled` and lets
`hasLiveWork()` clear. The stale row exposed a code defect too: archiving a conversation previously
hid its queued replies without settling them. `ConversationService.setArchived()` now cancels queued
messages in the same transaction, with a repository regression test. This preserves the running-turn
cancellation path while ensuring an archived thread cannot leave a permanent promotion blocker.

General lesson: when promotions report "queued" but never build and the promotion message's lease
keeps renewing (not expired), don't assume the promotion worker itself is broken — check
`hasLiveWork()`'s inputs directly: `SELECT id, status, author, dispatch_target, created_at FROM
shared_messages WHERE status IN ('queued','running')`. A long-idle `queued` row authored by `codex` or
`claude` (especially in a conversation named like a disposable repro/test) is the usual cause, and
canceling it unblocks the whole promotion queue immediately. `waitForPromotionSlot()` has no timeout on
`hasLiveWork()`, so a single orphaned test message can wedge every future promotion indefinitely —
e2e specs that intentionally create long-"running" messages to test streaming/overlap UI should clean
them up (or cancel/complete them) in an `afterEach`/`afterAll`, not leave them queued forever.

### <a id="25"></a>25. Automatic GC backstop for orphaned queued `shared_messages` (follow-up to the incident above)

The 2026-08-25 incident above was fixed by hand (`cancel_conversation_message`) plus a point-fix in
`ConversationService.setArchived()`. Neither generalizes: any future path that inserts a
`shared_messages` row with `author IN ('codex','claude')` and `status = 'queued'` that never gets
claimed (crashed dispatch, bad `dispatch_target`, new test tooling) reproduces the same
promotion-blocking bug, since `reclaimExpired()` only ever resets *leased* (`running`) rows — a
`queued` row has no lease and is invisible to it, and `waitForPromotionSlot()` still has no timeout.

Added `ExecutionService.reclaimOrphanedQueuedMessages(graceMs = 15 * 60_000)` (facade:
`repository.reclaimOrphanedQueuedMessages()`), wired into `scheduler.ts`'s 5s `tick` alongside the
existing `reclaimExpired()`/`surfaceStrandedRuns()` calls. It cancels any `shared_messages` row with
`status = 'queued'`, `author IN ('codex','claude')`, and `created_at` older than the grace period,
setting `status = 'canceled'` (not `'failed'` — the row never started, so there's no interrupted work
to report). The grace period is 5x `reclaimExpired`'s 3-minute default because a legitimately queued
codex/claude message can wait several minutes for a busy agent to free up in `dispatchNextSharedTurn`;
only a row idle far longer than that is actually orphaned. `jeffrey`-authored queued dispatch rows are
untouched by design — they aren't in `hasLiveWork()`'s filter and already get retried via
`dispatchNextSharedTurn`'s `finally`-block calls. Tests in `repository.test.ts` cover: an aged
codex/claude queued row gets canceled and `hasLiveWork()` flips false; a fresh one is left alone; a
`jeffrey` row is never touched regardless of age.

### <a id="26"></a>26. Runtime release publication must be staged, validated, and cross-process serialized

Jeffrey's decision (2026-08-25): promotion flakiness is unacceptable; a promotion queue must prevent
and resolve competing release handoffs. The incident showed a successful Vite build followed by
`Runtime promotion did not produce a usable client snapshot.` The release script had switched
`.workbench-runtime/current` before validating the copied release, and the filesystem pointer had no
lock outside the SQLite-backed worker queue. `scripts/promote-runtime.ts` now takes an exclusive
filesystem lock (dead-PID locks are reclaimed; a live holder has a 60-second wait), creates a unique
staging release, validates the server entry, manifest, HTML, and every HTML-referenced client asset,
then atomically renames the staging directory and swaps the symlink. Any copy or validation failure
leaves the known-good release untouched. The client build also uses explicit Rollup vendor chunks so
the app entry stays under Vite's 500 KB warning threshold.

### <a id="27"></a>27. "Preview promotion failed" is usually a plain `tsc` error, not the promotion queue

Most "Preview promotion failed" reports since the queue hardening above have shown a normal
TypeScript compile error (`tsc -b` failing before Vite even runs), not a promotion-queue race. The
recurring shape: a field gets added to `SharedMessage` in `src/shared/contracts.ts`, and hand-built
test fixtures across `src/server/shared-room.test.ts`, `src/client/App.test.tsx`,
`src/client/features/conversation/view.test.ts`, etc. fall out of sync with the type (missing a new
required field, or accidentally duplicating one during a merge). The fix is always to add/remove the
field in the literal object, not to touch the promotion queue or release script. When a promotion
failure message includes a `tsc` line/column error, diagnose it as a type-fixture drift first — run
`npx tsc -b` locally to see the full list before assuming the queue itself is flaky.

### <a id="28"></a>28. Offsite database backups must survive GitHub's file-size limit

On 2026-08-25, launchd continued creating local SQLite snapshots every four hours, but GitHub had
silently rejected every offsite push since 2026-08-24 because `latest.db` exceeded its 100 MB
per-file limit. `scripts/backup.ts` now gzip-compresses and splits the redacted snapshot into
90 MB `latest.db.gz.partNNNN` files before pushing. The chunks must be staged with `git add -f`,
because generated archives may be ignored by the backup repository. Restore with
`cat latest.db.gz.part* > latest.db.gz && gzip -dk latest.db.gz`, then run SQLite integrity and
foreign-key checks. A manual push plus a launchd RunAtLoad run both succeeded after the fix; the
remote copy passed `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.

### <a id="29"></a>29. Promotion queue depth, in-flight progress, and last build outcome are now globally visible

Jeffrey's request (2026-08-25): "i need to see the promotion queue and promotion status and build
status" and "this needs to be prominent." The existing `/api/runtime/preview-status` +
`getRuntimePreviewStatus` pair only answers "does the current editable tree differ from what's
promoted," and the only place it surfaced was a per-conversation approval banner — not global. Added
`ExecutionService.getPromotionQueueStatus()` (queried straight off existing `shared_messages` rows
filtered on `dispatch_target = 'promotion'`; no migration needed, since queue depth, the running
row's progress body, and the latest completed/failed row's body/error were already columns on that
table), a `WorkItemRepository.getPromotionQueueStatus()` delegate, a new
`GET /api/runtime/promotion-status` route, a `runtimeClient.getPromotionQueueStatus()` client method,
and a `PromotionQueueStatus` widget rendered directly under the sidebar brand mark in
`navigation/view.tsx` (global, on every page, polling every 2s) — showing "Promoting…" + queued
count while running, "N promotions queued" while idle with a backlog, or the last build's
success/failure once the queue is empty. While touching `system-router.ts` also fixed a duplicate
`response.json(runtimePreviewStatus())` call in the existing preview-status handler (Express throws
`ERR_HTTP_HEADERS_SENT` on a second `.json()` call in one handler; it had not yet been hit in
practice because the first call already ends the response before the second executes, but it was a
live latent bug).

### <a id="30"></a>30. Never run a Writer repo's full test suite locally **(core rule, always)**

Jeffrey's explicit, forceful instruction (2026-08-25): when working in any Writer repository, never
run the full local test suite. Doing so is heavy enough to overload his machine, and Workbench runs
on that same machine — an overloaded machine takes Workbench down with it, so this is a
shared-infrastructure risk, not just a slow command.

Only run individual test files in isolation (target a specific test file or a scoped `-t`/pattern
filter). Never invoke the whole-suite command (`npm test`, `npx vitest run` with no path/filter,
`pnpm test`, etc.) in a Writer repo. This applies to every agent working in this shared environment.
Also recorded in `shared-memory/writer-context.md` since it is specifically about Writer repos.

### <a id="31"></a>31. Never act on an external system without Jeffrey's explicit, request-specific permission **(core rule, always)**

Jeffrey's explicit, forceful instruction (2026-08-26): no agent may take an action on GitHub, Slack,
Confluence, Linear, or any other external website/service/CLI without his explicit permission for
that specific action. This is a hard-deny rule, not a default-caution one — an agent that finds a
plausible reason to comment, publish, sync, or otherwise act externally must still stop and ask,
because a prior approval for one action does not carry over to the next one.

An unambiguous current-turn user command to `PUSH`, or to `COMMIT AND PUSH`, is itself the explicit,
request-specific authorization to create the corresponding local commit and run that `git push`; do it
without requesting an additional permission grant. It authorizes only that push for the current requested
work, not other external actions, and a quoted or conditional mention is not a command to push.

The same capability model applies to other external services: a direct current-turn command naming the
operation and destination (for example, "post this summary as a comment on GitHub PR #42" or "update
this Linear issue") authorizes only that exact operation. Generic task text, prior approvals, and
unrelated external reads/writes remain denied.

*Classifier lifecycle correction, 2026-08-31.* Authorization remains a lightweight model judgment,
not a deterministic phrase matcher. Keep that classifier warm, start each timeout only when its queued
judgment actually begins executing, and resolve the decision once per human message so Codex and Claude
receive the same one-turn capability. A direct imperative such as “create a Linear card” is itself the
grant; classifier cold-start or queue latency must not be misreported as a valid negative judgment.

The Workbench supervisor should enforce this structurally, not rely on each agent remembering it:
detect when a dispatched agent attempts an action against an external website or CLI without a
permission grant tied to that specific request, and auto-deny it before it executes. Treat a direct
`PUSH` command as the permission grant for the current git push. Passive,
read-only lookups (checking PR/CI status, reading a Slack thread) are lower-risk than mutations, but
when in doubt about whether a call counts as "acting," treat it as requiring permission.

### <a id="32"></a>32. Always name the surface where Jeffrey can see finished work

Jeffrey's correction (2026-08-29), verbatim: "ok where am i supposed to fucking see these changes??"
He had just been handed several "done, verified" reports covering client and server work, none of
which told him a URL. The reports were accurate about the code and useless for actually looking at
it, because Workbench's local topology hides the gap: the app Jeffrey habitually visits at
**http://localhost:5180 is a promoted release**, served from a frozen snapshot under
`.workbench-runtime/releases/<id>/` (prebuilt `client/` assets plus a copied `src/server`), not from
the working tree. Editing files in `~/dev/workbench` changes nothing at :5180 until a new promotion
is cut. `vite.config.ts` asks for port 5180 too, so when the release runtime already holds it the dev
server silently lands on **:5181**, and nothing tells Jeffrey his changes moved to a different port.

The rule: a completion report is not finished until it says where to look. State the exact URL, and
state which categories of change are and are not visible there. In this repo that means distinguishing
client changes — visible immediately on the working-tree dev server with HMR — from server changes,
which are not visible until promotion, because the preview server proxies `/api` to the promoted
runtime rather than running the working-tree server. When the honest answer is "nowhere yet, this
needs a promotion," say that plainly instead of letting "done and verified" imply it is observable.

Verify the surface rather than assuming it. Grepping the running release's built asset for a selector
or string that only exists in the working tree is a cheap, decisive test of whether Jeffrey's browser
is being served the new code.


## <a id="34"></a>34. One ticket means one branch and one worktree

On 2026-09-11, two agents each set up their own CON-270 checkout — Claude created the branch
`jeffrey/CON-270/basic-auth-blank-password` while Codex created `con-270-basic-auth` in the worktree
`~/dev/writer-monorepo-con-270-basic-auth`. Jeffrey's reaction was "i don't want a worktree and a
branch - consolidate for fucks sake." This echoes an earlier correction on 2026-09-03: "why aren't you
just wholesale swapping the worktree into my working branch??????"

A single ticket gets exactly one branch in exactly one worktree. When parallel agents explore the same
ticket, reconcile their output into that one location before reporting — delete the duplicate branch,
rename the survivor to the repository convention (`jeffrey/CON-<number>/<slug>`, matching
`jeffrey/CON-230/connector-search`), and leave no second checkout behind. Jeffrey should never have to
choose between two half-set-up copies of the same work, and asking him which branch to keep is itself
the failure.


## <a id="35"></a>35. Worktrees must live directly under ~/dev, not in a hidden Workbench directory

On CON-465 Jeffrey said "i can't access that fucking worktree retard, move it to ~/dev" after work
was started in `~/dev/.workbench-worktrees/fe.web-app-<hash>/tasks/con-465`. He opens worktrees
himself — in an editor, a terminal, and a browser dev server — so a path buried under a dotted,
hash-named Workbench directory is unusable to him even though it is a valid git worktree.

Every worktree must therefore be created as a direct, human-readable child of `~/dev`, named after
the repository and the ticket, for example `~/dev/fe.web-app-con-465`. This holds regardless of what
path a Workbench task routing block suggests: if routing points at `.workbench-worktrees`, create or
move the worktree to `~/dev/<repo>-<ticket>` and work there instead.

## <a id="36"></a>36. Concurrent Workbench runs that each add a migration collide on the number

Learned 2026-10-08 while landing the agent-harness plan. Every run forks main at dispatch and
takes "the next migration id", so two runs dispatched in the same wave both wrote `084`, then
`087`, then `089`, then `092`. Workbench's integration applies per file, so the second run's
`database.ts`, `database.test.ts`, and usually `agent-runner.ts` were left behind in its worktree
with a "conflicting file(s)" note on the commit, and main carried half a feature.

Rule: dispatch at most one migration-adding task per wave, and at most one task per wave that
edits `src/server/agent-runner.ts`. When a collision does happen, land the leftover files from the
run worktree by hand with the newer migration renumbered to the next free id, rename the id in its
upgrade-path test too, and re-run `database.test.ts` before marking the task complete.

## <a id="37"></a>37. Claude safeguard refusals hit tasks about authorization, extraction, adversarial review, and memory removal

Learned 2026-10-08. Five Workbench runs on Claude (Opus and Sonnet) were refused by the model
provider's safeguard with `Details: [reasoning_extraction]`, four of them after the implementation
was already complete and only the final message remained. The task descriptions shared a pattern:
enforcing push/PR authorization in code, extracting citations from model output, running an
adversarial review lens that "tries to break" the code, and consolidating or removing memory.
Codex ran the same descriptions without complaint.

Rule: assign tasks on those themes to Codex at creation (`assignees: ["codex"]`) instead of
letting the classifier pick Claude. When a Claude run does get refused after doing the work, the
worktree still holds it: typecheck and test there, then land it by hand rather than paying for a
rerun. Workbench now records this outcome as `failureKind: provider_refusal` and retries with the
other vendor.

## <a id="38"></a>38. After an index-only landing, sync the primary working tree with `git stash`, not `git checkout`

Learned 2026-10-08. Landing a patch on main from an interactive Claude session follows Workbench's
own integration method: `git apply --cached --3way` into the primary checkout's index, then
`git commit`. That leaves the working tree showing the pre-landing content as modified. The
auto-mode permission classifier refuses both `git checkout HEAD -- <files>` and a forward
`git apply` in the primary checkout as "irreversible local destruction", even when the drift is
exactly the reverse of the commit just made.

Rule: confirm first that the working-tree diff equals the reverse of the landed patch
(`git apply --stat -R <patch>` against `git diff --stat`), then run
`git stash push -m "<why>" -- <those files>`. The tree matches HEAD, nothing is lost, and the stash
entry is junk Jeffrey can drop. Typecheck main in a clean detached worktree at HEAD, never in the
primary checkout, so a stale working tree cannot produce phantom errors.

## <a id="39"></a>39. Runtime code resolves repository paths from the working directory, never from its own file

Learned 2026-10-08 when the first promotion of the agent-harness work crashed on boot. A promoted
release is a copy of `src/server`, `src/shared`, and `dist/client` under
`.workbench-runtime/releases/<id>`, started with the repository as its working directory. `docs/`,
`scripts/`, and everything else stay in the repository. The new persona loader built its path with
`new URL('../../docs/personas/', import.meta.url)`, which exists in the repository and not in the
release copy, so the release exited with ENOENT while the gateway kept the old build and retried
every second. The preflight did not catch it because it booted the repository sources, not a copy.

Rule: any server module that reads or writes repository-owned files (`docs/shared-memory`,
`docs/personas`, `docs/work-log.md`, `scripts/agent-bin`) resolves them from `process.cwd()` with an
environment override for tests, the way `work-log.ts`, `record-learning.ts`, `knowledge-drift.ts`,
and `memory-index.ts` already do. `import.meta.url` is only for files that ship inside `src/`. The
promotion preflight now boots a release-shaped copy (`scripts/promote-runtime.ts`), so a path that
only works in the repository fails the gate instead of the live switch. When a promotion "succeeds"
but `/api/health` keeps the old `buildId`, read `data/logs/runtime.err.log` for the boot error.

### <a id="40"></a>40. Discovery consolidation card existed but was never mounted; proposals are mostly no-op keeps

src/client/features/discovery/consolidation-card.tsx had passing unit tests but no render site and no styles, so users never saw it. Unit tests on a component do not prove it is reachable. Before changing a feature card, grep for where it is mounted. Also, a real consolidation proposal reviewed 462 entries: 15 archive, 0 promote, 447 keep. Keep verdicts change nothing, so the UI should lead with counts, list only archive and promote items, and fold the keeps into a closed disclosure. That rule now lives in discovery/logic.ts. Unverified in a browser as of 2026-10-08.

*Provenance: d75ec969-7666-4431-8d65-a4883a0da300*

### <a id="41"></a>41. A long-lived agent process cannot carry per-turn authority in its environment

Found while planning persistent agent sessions (2026-10-08). The git/gh/curl shims in `scripts/agent-bin/external-action-command-guard.mjs` read the external-action capability from `process.env.WORKBENCH_EXTERNAL_CAPABILITY`. `externalActionGuardEnvironment()` in `src/server/external-action-command-guard.ts` sets that variable once, when the process is spawned. That works only because every turn spawns a new CLI. A process that serves many turns would keep the first turn's capability, or none, for its whole life. Any persistent-session design must first move the capability into a file the runner rewrites at the start of each turn and clears at its end. The env variable then holds only the file's path. Two other places assume a fresh process: `providerSessionForAuthorization` and the status-only-turn reset in `src/server/shared-room.ts` both start a new provider session on purpose.

CLI facts checked locally the same day (`claude` 2.1.295, `codex-cli` 0.161.0):
- `claude -p` accepts `--session-id <uuid>`, so Workbench can choose the session id up front.
- `--replay-user-messages` echoes stdin user messages on stdout (stream-json in and out).
- `--permission-prompts none` denies anything that would prompt instead of blocking.
- `codex app-server` has a user-wide `daemon` subcommand. It loads `~/.codex` config, so it skips Workbench's `--ignore-user-config` and per-account isolation.

Not verified: whether Claude's stream-json stdin accepts an interrupt or model-switch control request.

*Provenance: 8567e598-6c93-445d-81de-dc19ff351629*

### <a id="42"></a>42. Older memory replies store a merged count and no entry ids

Replies stored before the memory split keep the old combined total in their memory count. Reply 8ca506d5 stored 13 but had only 8 retrieved items. Badge code must work out the count when the reply is read, by counting retrieved items. It must not trust the stored total, and it must not rewrite stored rows. These older replies also saved no entry ids. That means `[file.md#N]` citations cannot be rebuilt for their `doc` lesson items. Only new replies can show those citations. Citations come from any entry id that ends in `#N` (`memoryCitation` in src/server/memory-retrieval.ts), not from the item's type.

### <a id="43"></a>43. Never stop :5180 to test MCP reconnect; agent runs depend on it

The live Workbench runtime on localhost:5180 is more than Jeffrey's UI. It is also the MCP server for every running agent, including the agent doing the test. A ticket or plan that says "stop/restart 5180" to test MCP reconnect would take down Jeffrey's UI and kill the testing run partway through. Observed 2026-10-08 while planning the persistent-sessions spike: `lsof` on :5180 showed the node runtime (PID 96516), and that same run was using it for MCP.

What to do: test reconnect against a throwaway MCP server inside the test script, on a spare port such as 5199. Workbench's real MCP handler keeps no per-connection state (src/server/workbench-mcp.ts ~line 992-995), so a stateless McpServer + StreamableHTTPServerTransport exercises the same reconnect path. A second full Workbench API with a copied database is heavier and no more faithful for this question. When a ticket asks to stop 5180, flag it as a conflict before acting and propose the stand-in.

### <a id="44"></a>44. Per-turn capability file: what commit d2f7eac does and what is still unwired

Follow-up to [workbench-operating-practices.md#41], from reviewing commit d2f7eac on 2026-10-08.

- The shim (`scripts/agent-bin/external-action-command-guard.mjs`) reads `WORKBENCH_EXTERNAL_CAPABILITY_FILE` on every git/gh/curl call. It falls back to `WORKBENCH_EXTERNAL_CAPABILITY` only when the file variable is absent.
- It refuses when it can't read the file. The capability file shares a temp directory with `refusals.jsonl`. The cleanup returned by `observeExternalActionRefusals` deletes that directory, so every later command is refused.
- Don't flag inherited env variables as a leak risk. Child environments are built from an allowlist (`ALLOWED_AGENT_ENV_KEYS` in `src/server/agent-security.ts`), so a `WORKBENCH_EXTERNAL_CAPABILITY_FILE` in the server's own environment never reaches an agent.
- Still to do, as of 2026-10-08: `writeTurnCapability` and `clearTurnCapability` have no callers. The room process (`src/server/shared-room.ts`) and runs still get one capability per process until the persistent-session host calls them at turn start and end.

*Provenance: dfb49577-24ba-4659-a4a9-dae36abb7bad*

### <a id="45"></a>45. Claude stream-json persistent process control and MCP reconnect

Verified 2026-10-08 with Claude CLI 2.1.295 via `npx tsx scripts/session-spike.ts`: one `claude -p --input-format stream-json --output-format stream-json --session-id <uuid> --replay-user-messages` process accepted three user messages on stdin and retained the same PID/start time. `control_request` envelopes work for `interrupt` and `set_model`; responses nest the request id at `response.request_id`. Interrupt yields a `result` with `terminal_reason: "aborted_tools"`, and the next user turn works on the same process. A stateless Streamable HTTP MCP server restarted on the same port reconnected automatically on the next tool call, with no MCP controls or `--resume`. Do not use per-turn cwd for Claude: cwd is selected when the process starts. The harness kills Claude and stops the test server in `finally`.

*Provenance: 06114199-a2d3-4280-905d-46bea3a333d0*

### <a id="46"></a>46. Codex app-server persistent-thread spike results

Codex CLI 0.161.0 app-server supports multiple `turn/start` calls on one non-ephemeral thread, `turn/interrupt` with `{threadId, turnId}`, per-turn `cwd`, `model`, and `effort`, and automatic reconnect to a restarted stateless HTTP MCP server. Verified on 2026-10-08 with `scripts/session-spike.ts`: one PID completed three turns, interrupted a long turn and accepted the next one, used separate marker directories with low/high effort recorded in the session log, and called `spike_ping` after port 5199 restarted without status/list, reload, or resume. The app server also attempted configured unrelated remote MCP servers; their OAuth failures did not prevent the throwaway server check.

*Provenance: 3ea3bec9-82ff-4166-93f5-8d940a8fa64f*

### <a id="47"></a>47. Agent session hosts keep sockets in the temp directory and outlive the runtime on purpose

Found while building the session host (2026-10-08). `src/server/agent-session-host.mjs` is a detached worker per (conversation, agent), started by `ensureSession` in `src/server/agent-session.ts`. Its files live under `WORKBENCH_AGENT_SESSIONS_DIR` (default `data/agent-sessions/<conversationId>/<agent>/`: spec.json, status.json, events.jsonl, stderr.log). Its Unix socket does not live there: macOS caps socket paths near 104 bytes and a worktree data directory already exceeds that. The socket is `$TMPDIR/wb-session-<hash>.sock`, and the real path is recorded in status.json and `agent_sessions.socket_path`. Always read it from there rather than recomputing it. Runtime shutdown deliberately leaves hosts running; `reattachAll` adopts them at boot. A host spawned before the per-turn capability file was attached gets `WORKBENCH_EXTERNAL_CAPABILITY='{}'` (deny all) for its whole life. See [workbench-operating-practices.md#41]. Test fakes that print and then `process.exit` must use `writeSync(1, …)`: macOS pipe stdout is asynchronous, so the last line is lost otherwise.

*Provenance: 6285ed3a-91a9-4767-b924-7711b1de5a70*

### <a id="48"></a>48. Agent session hosts have no single-start guard; add one before wiring a caller

Found in review of run 042d1595 (2026-10-08). `ensureSession` in `src/server/agent-session.ts` has no per-key lock, and `agent-session-host.mjs` unconditionally unlinks its socket path at startup. Two concurrent `ensureSession` calls for the same (conversation, agent) both see no live host and start two hosts: the second deletes the first's socket, both append to the same events.jsonl with independent offset counters, and both resume the same Claude session id. Nothing calls the client yet, so this is latent. Before any caller is connected, add an in-process in-flight promise per key in `ensureSession` and make the host refuse to start when the existing socket still answers. Two related gaps to fix at the same time: a turn sent while the host is killing a CLI that ignored an interrupt goes to the dying process and fails as `provider_exited` (null `child` on host kill), and a live host is reused even when the account profile or cwd changed (compare and restart on mismatch).

*Provenance: 6285ed3a-91a9-4767-b924-7711b1de5a70*

### <a id="49"></a>49. Session-mode memory: where the prefetch lives

In session mode (WORKBENCH_PERSISTENT_SESSIONS=1), Workbench-side memory prefetch lives in replyInSharedRoom and dispatchNextSharedTurn in src/server/shared-room.ts, not at the line numbers a ticket cited (shared-room ~1744/1790, agent-runner 2189/2258). Tickets' line numbers go stale; search by function name. The per-run path in agent-runner.ts never uses session mode, so it was left alone. Session turns now skip searchActivityMemory and getSharedContextWithItems; agents call recall_context and record_learning themselves per RUNNER_SYSTEM_CONTRACT. Retrieved-memory badge uses retrievedMemoryCount=null (shows "—") with detail.agentDriven=true; the badge tooltip still says "older reply" (client not changed).

### <a id="50"></a>50. Use scripts/preview-api.ts for end-to-end agent checks against a database copy

To exercise real agent dispatch against a copied Workbench database, start scripts/preview-api.ts. It uses previewRuntimeCapabilities (src/server/runtime-capabilities.ts): executeAgents true, ownScheduler false, runDiscoveryCatchUp false. So the copy's queued work never runs. Do not use src/server/index.ts: it uses live capabilities and owns the scheduler. Do not use scripts/e2e-api.ts either: e2eRuntimeCapabilities turns agent dispatch off. Also, vitest only includes src/**/*.test.ts(x) (vitest.config.ts:6). Logic for a new scripts/ entry point must live in src/ to be testable. Verified in source 2026-10-08.

*Provenance: 98ce376e-6ba5-4074-ae35-b2762c6355b1*

### <a id="51"></a>51. Session turns write their usage diagnostic only at turn end

In src/server/shared-room.ts, persistent-session turns (WORKBENCH_PERSISTENT_SESSIONS=1) write their only 'usage' diagnostic in runSharedSessionTurn's .then, after the turn completes (around line 2337). The session sink's onUsage and onEvents update the run but write no agent_run_diagnostics row. Per-run Claude and Codex paths write a 'usage' diagnostic on every streamed usage update. So any latency metric taken from MIN(agent_run_diagnostics.created_at) is really the whole turn's duration for sessions and the first-token time for per-run, which makes sessions look slower. scripts/session-cost-report.ts (commit 6fe891e) has this bias. Before comparing session and per-run timing, write a diagnostic on the session's first provider event, or use a timestamp other than diagnostics.

*Provenance: d3551fa8-53fd-4ddd-a112-c013165a67de*

### <a id="52"></a>52. Session-turn start-to-first-activity needs a first-event diagnostic

Persistent-session turns write their only `usage` diagnostic when the turn ends, so a start-to-first-activity metric built on the earliest `tool` or `usage` diagnostic reports the whole turn duration for sessions. Fix: shared-room.ts writes one `tool` diagnostic with `{ category: 'session_first_event' }` on the first provider event of a turn (via an optional onFirstEvent hook in the session turn reader). Use kind `tool`, not a new kind: the diagnostics table CHECK constraint allows only `prompt`, `usage` and `tool`, so a new kind would need a migration. Keep excluding `prompt` diagnostics from the report, since they are written at run start and always give 0s.

### <a id="53"></a>53. Persistent sessions: a busy session ignores a changed worktree and shares one capability file

ensureSession (src/server/agent-session.ts) restarts the host with --resume on a cwd change only when the session state is not 'turn'. If another turn (for example a chat reply) is running on the same conversation and agent, a task run in a different worktree reuses that process and executes in the other turn's cwd, possibly the primary checkout. Overlapping turns also share one capability file: writeTurnCapability overwrites the grant and the first turn to finish clears it for the other. Any change that routes more run kinds onto the conversation session (commit 5571956, task 66235d6b) must serialize turns per session or isolate busy-session runs. Review of that commit found this; unverified whether an execute run can overlap a chat turn in practice.

*Provenance: 66235d6b-8e27-4e05-9294-1b4bcbe49df4*

### <a id="54"></a>54. Persistent sessions default on; fan-out and failures use per-run path

Persistent agent sessions are on unless WORKBENCH_PERSISTENT_SESSIONS is exactly '0'; persistentSessionsEnabled() in src/server/shared-room.ts is the single reader. Fan-out replies (a message sent to both agents, including task runs) keep per-run processes. A non-cancel session turn failure reruns on the per-run path with the existing Claude-to-Codex rules. The fallback prompt carries no pre-fetched long-term memory because sessions skip it; the agent can still call recall_context. Verified with the real claude CLI: one process served three turns. Operational trap: an assigned run worktree can be deleted from outside the run; recreate it from main at the same path and relink node_modules.

### <a id="55"></a>55. Session-turn fallback must not rerun a turn that already started

Commit cdc5571 (task dee59961) makes any non-cancel persistent-session turn failure rerun the whole request on a per-run process. See replyInSharedRoom in src/server/shared-room.ts (~:2442) and executeAgentRun in src/server/agent-runner.ts (~:2452). runSharedSessionTurn throws on turn status 'failed' or 'interrupted' after the agent may already have edited files, committed, pushed, or posted externally. The rerun then repeats those side effects. Fall back only when ensureSession or submitTurn fails, before the turn is accepted. Report later failures instead of retrying them. A related trap: the same commit excludes replies to messages sent to both agents from sessions, citing "each needs a process of its own". Sessions are already keyed by {conversationId, agent}, so that reason is wrong. Found by review of run 977f8f54. Duplicate side effects were not reproduced live.

*Provenance: dee59961-e797-4010-a56f-083398533ce6*

### <a id="56"></a>56. Shared agent sessions need a per-session turn lock and owner-stamped capability files

A chat turn and a task run can share one live agent session. Without serialization, the run reuses the chat turn's host process and edits the wrong directory. Overlapping turns also clear each other's capability file. Fix: runSharedSessionTurn in src/server/shared-room.ts queues turns per conversation+agent, and ensureSession restarts the host with --resume when the worktree differs. The capability file now stores the writing turn id under __turnId, and a turn clears it only if it wrote it. Limit: the lock is in-process, so it does not cover a second runtime or a turn still running in a host after a server restart. Unrelated pre-existing failure on the base commit: repository.test.ts "retrieves one shared memory snapshot for a dated repeat request" (searchActivityMemory called twice).

### <a id="57"></a>57. Restart pickup of an unfinished session reply must wait in the per-session turn queue

This builds on [workbench-operating-practices.md#56]. At startup, src/server/index.ts:53 runs reattachAgentSessions and then recoverSharedSessionTurns, without awaiting them, while the scheduler is already running. Recovery waits up to LEASE_MS + 5s to claim the reply, then waits for the in-flight turn, and never takes withSessionTurnLock (src/server/shared-room.ts). During that window, a queued execute run on the same conversation and agent finds the lock free. Its ensureSession call then either reuses the busy host, so it edits the reply's directory, or restarts the host with --resume, which kills the recovered reply. Fix: make recovery wait in withSessionTurnLock under the same `${conversationId}:${agent}` key before it reads the in-flight turn. Related trap: syncWaitingReasons in src/server/repositories/run-repository.ts:548 keeps the waiting reason only by matching the text 'waiting for the session%', so renaming SESSION_TURN_WAITING_REASON silently erases the status. Not a risk: the __turnId key in capability.json never grants anything, because the guard only checks for the named permission it needs (scripts/agent-bin/external-action-command-guard.mjs:63-69). Found by reading code in the review of commit f3e43d0 on 2026-10-08; not reproduced at runtime.

*Provenance: 03903338-b30d-4527-a817-daeb65693fb0*

### <a id="58"></a>58. Boot recovery must reserve the session turn queue slot synchronously

Recovered session turns join the per-(conversation, agent) queue in shared-room.ts. The slot must be taken (enqueueSessionTurn) for every live agent_sessions row BEFORE any await in recoverSharedSessionTurns, because the scheduler is already running and a task run can take the lock during the async tail() scan. Reserving per row keeps different conversations parallel. Related traps: sessionTurnAttempts is a process-global map keyed by messageId, so tests reusing a messageId see turnId #2; and the Claude-to-Codex capacity fallback catch receives SessionTurnStartedError (message preserved), so isAgentCapacityError matches it unless guarded by canFallBackToPerRun. The 'Claude session expired' retry branch has the same unguarded re-run gap.

*Provenance: b55fd1d0-98c5-4d2e-a309-50f35040ff63*

### <a id="59"></a>59. Boot recovery must queue before the scheduler starts, and keep its lease alive while queued

Review of commit ba6714c (restart recovery joins per-session turn queue) found two gaps a unit test with a fake agent will not show. (1) src/server/index.ts starts the scheduler before recoverSharedSessionTurns runs (after an async step), so a task run can take the session slot first; slot claiming for recovered turns must happen before the scheduler starts. (2) In recoverSharedSessionTurns the message lease is claimed, but the renewal timer starts only after the wait for the previous turn, so a long run in front lets the reply's lease lapse. Any code that waits in a queue while owning a lease must renew the lease during the wait.

*Provenance: 0af4537e-1cbb-4426-bfef-4f43e06be833*
