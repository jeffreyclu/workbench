## Workbench operating practices

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

**Shared context is mandatory; budgeting must preserve it.** Jeffrey clarified on 2026-08-24 that
shared context is Workbench's most critical requirement, not a feature that can be traded away to
control model usage. Context controls must therefore retain durable shared facts and make them
available to every agent: constrain each run's transient prompt, retrieve the smallest relevant
shared-memory evidence automatically, and persist useful outcomes back to the shared store. Never
solve cost or token overruns by creating agent-private context, withholding shared context, or
discarding durable history.

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
