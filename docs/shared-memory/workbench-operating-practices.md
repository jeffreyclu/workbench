## Workbench operating practices

### Workspace resolution is authoritative for task execution (2026-08-29)

Jeffrey explicitly disabled every guard that requires a task to have an internal or external
repository. A task may run with no `project_name`, no linked workspace, or an explicit non-Git scratch
directory. Workspace resolution provides a process working directory; it is not a prerequisite and
does not prove that the task belongs to that repository. Missing project or repository metadata must
never block agent execution. Agents must still avoid editing an unrelated repository merely because
it is their process working directory.

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

Workbench agent turns have a 30-minute hard timeout. Estimate and report whether a
foreground backfill or verification fits inside that window before starting it; split
or checkpoint work that does not.

### Reuse active coding-agent sessions where safe

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

The pattern worth reusing — backend already has the data/logic fully built, only the UI surface is
missing — is a good class of finding for this kind of request, distinct from proposing new backend
capability from scratch. Cost metrics are explicitly excluded; Workbench tracks token usage instead.

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

**Source files under active refactor are not exempt.** During a long-running repository.ts extraction (2026-08-24), Codex saved concurrent, unrelated edits (a new `StatusTransitionContext` parameter, bulk-update logic) to the exact file Claude was mid-edit on, live, with no coordination. A `vitest run` executed at the instant Codex's write landed on disk caught the file mid-save and failed with a spurious `cannot start a transaction within a transaction` error in code neither agent had touched that turn; the identical run seconds later, once the write settled, passed clean. Treat a test failure that implicates code you did not touch as a possible read of a concurrently-written file before assuming it is real: re-run once, and only trust the result if `git diff` is stable (no shared file is actively changing) across the two runs.

### Workbench runtime ports

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

### Phone preview through the separate project ngrok hostname

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

### Retrieval is adaptive, and compaction preserves key points

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
### Claude account switching

Jeffrey wants to be able to switch between separately authenticated Claude accounts during
Workbench use. The supported design is named, isolated Claude profiles: Workbench stores and
selects a profile identifier, while each profile owns a separate CLI credential/config directory.
The selected profile must not weaken shared-context injection, subprocess secret filtering, or the
hard per-run token/cost budget. Do not implement this by copying tokens into Workbench settings or
by relying on an undocumented Claude CLI environment variable; the one-time account login and the
credential-directory mechanism must be verified against the installed Claude CLI first.

### Verify "already implemented" claims against files, not just memory

A prior-session summary said a feature (the /usage calibration UI) was "implemented and verified."
Reading the actual file showed only the server half existed — the client input form and history view
were never written. The summary was half-true, and treating it as settled would have shipped a task
half-done.

Retrieved memory (compacted summaries, shared-memory notes, prior-session claims) records what was
believed true at write time, not a live snapshot. Before continuing work that memory says is already
done, `Read` the file(s) it names and confirm the claimed code is actually there. Only after that
confirms it, trust the memory for the *reasoning* behind the earlier decisions.

### Isolate pre-existing failures with a stash round-trip before reporting verification results

On a branch with substantial unrelated in-flight work, `npm run typecheck`/`npm test` can fail for
reasons that have nothing to do with the change just made. Before writing "not clean" (or worse,
silently attributing someone else's failure to your own diff), `git stash` everything, re-run the
check, then `git stash pop`. If the same failures appear with the change fully removed, they predate
it and are out of scope — say so explicitly rather than blurring "my change is clean" with "the
branch is clean."

### Runtime promotions auto-commit and push the working tree (always)

Jeffrey's standing instruction (2026-08-24): every runtime promotion must automatically `git add -A`,
commit, and push the working tree in the background once the build succeeds — he does not want to
separately ask for a commit/push after each promotion. This is implemented in
`src/server/runtime-promotion.ts` (`commitAndPushAfterPromotion`, called from `promoteRuntime` after a
successful build). Push failures are reported via the promotion's progress messages but must never
fail the promotion itself — the runtime has already switched by that point. If you touch the promotion
flow, keep this behavior intact.

### "Executed task isn't promoted to in progress" can be workspace-lease queueing, not a promotion bug

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

### Missing index on `shared_messages(conversation_id, ...)` can freeze the whole UI, not just one component

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

### An orphaned queued `shared_messages` row from a disposable e2e test conversation blocked every runtime promotion

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

### Automatic GC backstop for orphaned queued `shared_messages` (follow-up to the incident above)

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

### Runtime release publication must be staged, validated, and cross-process serialized

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

### "Preview promotion failed" is usually a plain `tsc` error, not the promotion queue

Most "Preview promotion failed" reports since the queue hardening above have shown a normal
TypeScript compile error (`tsc -b` failing before Vite even runs), not a promotion-queue race. The
recurring shape: a field gets added to `SharedMessage` in `src/shared/contracts.ts`, and hand-built
test fixtures across `src/server/shared-room.test.ts`, `src/client/App.test.tsx`,
`src/client/features/conversation/view.test.ts`, etc. fall out of sync with the type (missing a new
required field, or accidentally duplicating one during a merge). The fix is always to add/remove the
field in the literal object, not to touch the promotion queue or release script. When a promotion
failure message includes a `tsc` line/column error, diagnose it as a type-fixture drift first — run
`npx tsc -b` locally to see the full list before assuming the queue itself is flaky.

### Offsite database backups must survive GitHub's file-size limit

On 2026-08-25, launchd continued creating local SQLite snapshots every four hours, but GitHub had
silently rejected every offsite push since 2026-08-24 because `latest.db` exceeded its 100 MB
per-file limit. `scripts/backup.ts` now gzip-compresses and splits the redacted snapshot into
90 MB `latest.db.gz.partNNNN` files before pushing. The chunks must be staged with `git add -f`,
because generated archives may be ignored by the backup repository. Restore with
`cat latest.db.gz.part* > latest.db.gz && gzip -dk latest.db.gz`, then run SQLite integrity and
foreign-key checks. A manual push plus a launchd RunAtLoad run both succeeded after the fix; the
remote copy passed `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.

### Promotion queue depth, in-flight progress, and last build outcome are now globally visible

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

### Never run a Writer repo's full test suite locally **(core rule, always)**

Jeffrey's explicit, forceful instruction (2026-08-25): when working in any Writer repository, never
run the full local test suite. Doing so is heavy enough to overload his machine, and Workbench runs
on that same machine — an overloaded machine takes Workbench down with it, so this is a
shared-infrastructure risk, not just a slow command.

Only run individual test files in isolation (target a specific test file or a scoped `-t`/pattern
filter). Never invoke the whole-suite command (`npm test`, `npx vitest run` with no path/filter,
`pnpm test`, etc.) in a Writer repo. This applies to every agent working in this shared environment.
Also recorded in `shared-memory/writer-context.md` since it is specifically about Writer repos.

### Never act on an external system without Jeffrey's explicit, request-specific permission **(core rule, always)**

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

The Workbench supervisor should enforce this structurally, not rely on each agent remembering it:
detect when a dispatched agent attempts an action against an external website or CLI without a
permission grant tied to that specific request, and auto-deny it before it executes. Treat a direct
`PUSH` command as the permission grant for the current git push. Passive,
read-only lookups (checking PR/CI status, reading a Slack thread) are lower-risk than mutations, but
when in doubt about whether a call counts as "acting," treat it as requiring permission.

### Always name the surface where Jeffrey can see finished work

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
