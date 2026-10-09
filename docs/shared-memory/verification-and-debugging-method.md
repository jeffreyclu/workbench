tier: portable
## <a id="20"></a>20. REMOVED -> discard-log.md 2026-10-09

Full text: [discard-log.md#5]

### <a id="1"></a>1. Status questions never resume older work **(always)**

A message asking only for status authorizes read-only inspection and an answer. It never carries forward
permission from an earlier turn to start a service, rerun a command, edit files, or continue a pending
plan. Keep the user-selected task category unchanged, but start a fresh provider session for a status-only
turn and state the no-action boundary explicitly so cached provider intent cannot replay.

### <a id="2"></a>2. Start every agent-debugging investigation with the decision graph **(always)**

When an agent behaves incorrectly, inspect that turn's decision graph before diagnosing the cause or
changing code. The graph is the primary evidence for what Workbench selected, what context and memory
it supplied, which rules fired, and why the agent produced that result. Correlate it with the stored
message, activity log, and runtime evidence as needed, but never skip it or substitute a source-only
hypothesis. This applies to Claude, Codex, Palmyra, and every future provider.

### <a id="3"></a>3. Every agent has full access to every local repository **(always)**

The resolved workspace is only an agent's starting directory and a concurrency
hint. It is never an authorization, filesystem, or Git boundary. Claude, Codex,
and Palmyra must always be able to read and write across Jeffrey's home directory,
change into sibling repositories, use absolute or parent paths, and run normal Git
branch/worktree commands when the current request calls for them. An unlinked
conversation does not become “Workbench-only” and never needs a linked task merely
to access another repository.

This supersedes and removes the old duplicate Workbench Git guards. Those guards
first blocked pathspec checkout during a baseline comparison, then caused an
unlinked `writer-monorepo` cleanup conversation to refuse the requested mutations
entirely. Keep external-service authorization and focused Writer-test rules separate:
they govern external side effects and test cost, not local repository access.

### <a id="4"></a>4. Verify in the right repo before asserting state

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

### <a id="5"></a>5. Verify rationale dont infer it

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

### <a id="6"></a>6. No recovery for untracked file edits

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


### <a id="7"></a>7. Edit as a single tracked worker, and verify from observed output **(always)**

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

### <a id="8"></a>8. Close the symptom Jeffrey reported, explicitly

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

### <a id="9"></a>9. Confirm root cause against real run data

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

### <a id="10"></a>10. Fix every identified cause, not just the one you ranked highest

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

### <a id="11"></a>11. Land approved fixes on a new branch

When Jeffrey approves a diagnosis and tells you to implement it, he consistently says "fix it on a new
branch." Treat it as the standing default rather than something to ask about: after he greenlights a
fix, run `git checkout -b <descriptive-branch>` before making any edits, and commit there.

It matters because investigation often happens on a branch already carrying unrelated in-flight work,
and committing the fix there entangles two independent changes and makes the fix hard to review or
revert alone. Two consequences: create the branch *before* editing, so the committed tree is only the
fix; and stage the specific files the fix touched (`git add <paths>`) rather than a broad `git add -A`,
because other agents and background processes write to the same working tree and a broad add silently
sweeps their in-flight edits into your commit.

### <a id="12"></a>12. Prefer proven, named methods over bespoke heuristics **(always)**

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

### <a id="13"></a>13. Trace a guardrail's origin before changing it

Reviewing a diff that raised `MAX_MAX_RESULTS` from 20 to 40 to fix a failing RAG test, Jeffrey's
reaction was not "does this fix the test" but "the old value must have been set for a reason — why was
it set at 20? we shouldn't change it just to pass a test."

Whenever a change touches an existing guardrail, ceiling, limit, timeout, retry count, or magic-number
constant, `git log -S`/blame it back to the commit that introduced it and state what it was protecting
against before proposing or accepting a new value. Present the change as "the original guardrail's
purpose was X; that purpose is still preserved because Y" rather than "raising the number makes the
test pass."

### <a id="14"></a>14. Check a diff against the original scope before reporting it done

On the Pluto RAG-guardrail task, a brief specified three layered pieces: a hard token-budget cap, a
three-tier eval system (deterministic component contracts, frozen-evidence generation, a live-agent
canary), and a working q21 stability check. The work was reported as "Implemented the RAG runaway-token
guardrail... 77/77 tests passed" — true as far as it went, but Jeffrey's own follow-up question ("do
these fixes do what you scoped out at the beginning?") surfaced three blocking gaps a second read
caught immediately: model-backed tools like `create_doc` still call the provider *before* checking the
budget, so the "hard cap" has an uncapped path; the "layered eval system" was mostly a facade (replay
tier still posts to the live agent, the component tier checks source titles against mutable Supabase
data instead of frozen source IDs, frozen-evidence generation was never built); and the authorization
canary (q33) can pass with zero seeded second project, so it can't actually detect cross-project
leakage. His verdict: "you fucked up."

- Passing unit tests and a clean typecheck verify that the code you wrote does what you intended — they
  do not verify that what you intended covers the original scope. Before reporting a scoped task
  complete, re-read the original brief/spec line by line and check off each stated piece against the
  diff, not against your own summary of the diff.
- A guardrail description ("hard token cap") needs to be checked for every call path that spends
  budget, not just the main path exercised by the tests you wrote. If a tool calls the provider before
  it reports usage, the cap does not cover it — say so up front rather than letting review find it.
- When a task explicitly promises a design (e.g. "layered evals" citing named external methodologies),
  do not report partial scaffolding using that design's vocabulary as if the design were realized.
  State plainly which layers exist, which are stubs, and which are missing.
- If self-review would have caught the gap Jeffrey found by asking one question, that is the standard
  to hit next time: ask "does this diff satisfy every clause of the original brief?" before reporting
  done, not after being asked.

### <a id="15"></a>15. Reset incomplete work before rebuilding it

On 2026-08-24, after the Pluto RAG guardrail/eval diff was shown to be incomplete against its stated
scope, Jeffrey directed: "let's clear the current dif and start fresh." When that instruction is
explicit, first enumerate the tracked and untracked files in the working tree, then discard that exact
set and verify the branch is clean. Do not salvage partial scaffolding or resume implementation from
it. The clean branch is the starting point for a new, fully scoped design; it does not authorize live
bench runs or provider spending.

### <a id="16"></a>16. Cite real evidence for every claim, not just the rationale

On a Wells Fargo SteerCo connector-feasibility task, an initial answer gave a vendor-by-vendor
feasibility verdict (Aprimo, Red Oak, Bloomberg, etc.) grounded in one real code citation but with
the rest of the verdicts stated as assertions. Jeffrey's reaction was blunt: "where the fuck is your
evidence for all this?"

This is the same failure mode as "verify rationale, don't infer it" above, but broader: it applies to
any factual or capability claim in a deliverable, not just "why a change is happening." Before stating
that something is feasible, hard, or true, produce the citable source backing it — a real file path
and code snippet fetched live (via `gh api`, not local guesswork, when the repo isn't checked out), or
a real external source (WebSearch result with URL) confirming the claim. When a WebSearch is used, the
mandatory "Sources:" section with linked URLs is not decoration — it is the evidence trail Jeffrey is
checking for. A confident-sounding table with no citations reads as fabrication even when the
underlying claims happen to be true; state plainly which claims are sourced and which are still
inferred/unverified rather than presenting both the same way.

### <a id="17"></a>17. Node toolchain: nvm, not mise

Jeffrey manages Node with **nvm** plus the official nodejs.org `.pkg` installer. Offered mise — which
would have matched `writer-monorepo/mise.toml` exactly — he declined it and asked specifically for nvm.
Reach for nvm commands rather than proposing mise, Homebrew, asdf, or volta.

One consequence worth remembering: `~/dev/writer-monorepo/mise.toml` pins node 22.19.0, python
3.12.13, uv 0.11.26, and installs pnpm via a postinstall hook. Because he is not using mise, those
versions are **not** applied automatically — matching the pinned node version and obtaining pnpm,
python 3.12, and uv has to happen by hand. Flag that gap rather than assuming his environment matches
the repo's declaration.

### <a id="18"></a>18. Never conclude "no AI signal is available" — Workbench can run a model in-process

Told that a diff had no AI confidence score to display, Jeffrey pushed back flatly: *"what do you mean
there's no AI confidence score? i don't believe that."* He was right, and the reasoning error is worth
generalizing. The earlier claim rested on the fact that the Messages API does not expose token-level
logprobs — true, but irrelevant, because a model can simply be *asked* to rate its own confidence, and
Workbench already ships that mechanism.

Workbench has an in-repo one-shot inference path: a `claude -p` subprocess spawned locally with the
model and tools locked down (see `src/server/fast-task-draft-ai.ts` and `src/server/diff-confidence-ai.ts`
for the established shape — `--model haiku --effort low --tools '' --strict-mcp-config --no-session-persistence
--output-format json`, run from `/tmp`, with a timeout, an in-memory cache keyed by a hash of the input,
and a strict parser that validates every key came back). Any future feature that wants a rating, score,
classification, or summary can reuse it rather than inventing a regex heuristic.

The durable rule: an *absence* claim ("there is no signal", "the API doesn't support that", "this
isn't available") is a claim like any other and needs evidence before it is stated. Search the codebase
for an existing mechanism first — in Workbench specifically, assume a model call is available until
proven otherwise. And when a heuristic is offered as a stand-in for a model judgment, say so explicitly
instead of letting it be read as the real thing.

## <a id="19"></a>19. Remove the divergence instead of patching one side of it

On 2026-08-31 (CON-194 connectors V2), a bug where the "Connected" section only reflected the first
page of profiles was first fixed by making the unsearched list eagerly page itself out, so that it
matched what the separate server-searched query already did. Jeffrey rejected that: "this still seems
like a patch. we should fix both queries no??? they should behave consistently. why do they not?"

The durable rule: when two code paths read the same data and behave differently, the fix is to
eliminate the duplication so one path serves both cases, not to teach the second path to imitate the
first. Making two caches, two cursors, or two result sets agree is a patch — they can always drift
again, and every downstream feature has to remember which one it is reading. Ask why the divergence
exists at all before making the sides match, and state the tradeoff plainly if collapsing them costs
a capability.


## <a id="21"></a>21. Never post code review comments to GitHub — draft them for Jeffrey (2026-08-28)

When Jeffrey asks for review comments on a pull request, the deliverable is text he will paste
himself, not a mutation. He interrupted a review of `WriterInternal/fe.web-app#5287` with "wait are
you trying to comment on GH?? don't do that. just tell me where and what to comment." Reviewing a PR
therefore means producing, for each finding, the exact file, the exact right-side line number in the
GitHub "Files changed" view, and the comment body ready to paste — and stopping there.

Read-only GitHub calls used to establish those anchors (`gh api .../pulls/<n>/files`, fetching
`refs/pull/<n>/head`, `git show`) are fine and are what make the line numbers trustworthy. What is
forbidden is any write: `gh pr review`, `gh pr comment`, `gh api -X POST` against a comments
endpoint. Anchor findings on lines that are actually part of the diff whenever possible, because a
line outside every hunk forces Jeffrey to expand context before GitHub will let him comment there.


## <a id="22"></a>22. Audits and static analysis run against `main`, not the checked-out branch

Jeffrey's correction on 2026-08-31, during the Manage Connectors action-catalog analysis: "YOU GUYS
SHOULD BE AUDITING MAIN NOT THE DIRTY WORKTREE FYI". I had begun cataloguing connector actions from
whatever branch happened to be checked out in `~/dev/writer-monorepo` — at that moment a feature
branch (`feat/con-connectors-v2-projection`) carrying in-progress, uncommitted work.

The rule is general: when the deliverable is an audit, inventory, catalog, coverage analysis, or any
other description of what the system *is*, the baseline is the repository's default branch. In-flight
branch work is a proposal, not the system of record, and describing it as current state produces a
document that is wrong the moment the branch is rebased or abandoned — and worse, invents test cases
for behavior that never shipped.

Practically: read the audited files with `git show main:<path>` (or an equivalent read-only view)
rather than switching branches, so a dirty working tree is never disturbed. If in-progress branch
work is genuinely relevant, it goes in a clearly separated "not yet on main" section, never mixed
into the main inventory. Confirm and state which ref the analysis was taken from.


## <a id="23"></a>23. An enumerated review-comment list is the whole scope (2026-08-31)

When Jeffrey says "address the bot comments" — or names any fixed set of items — that list is the
entire scope of the edit. Fix exactly those items and stop. Do not add tests for the code you just
touched, do not tidy neighboring code, and do not fold in improvements that seem obviously correct.
If a fix genuinely requires touching a file outside the stated scope, say so and get agreement
before doing it; that is a question, not a licence.

A bot suggestion does not widen the scope either. On PR #14774 a review bot asked for a duplicated
tooltip string to be extracted into `frontend/src/components/connectors/utils.ts` and imported by
both the V2 card and the legacy `connector-row-status.tsx`. Following it edited two files outside
`manage-tabs/connectors-v2/`, which collides with Jeffrey's standing rule that the connectors V2
work stays inside its own folder behind one gated entry point. The right move was to keep the
constant inside the V2 folder, or to leave the duplication and reply to the bot — not to follow the
suggestion into legacy code.

Learned when a six-comment instruction produced an eleven-file commit (`58f3c1512c`) whose largest
part, three new test files totalling ~219 of 260 inserted lines, nobody had asked for.


## <a id="24"></a>24. Review the PR's own code, from the PR branch — never the primary checkout's current branch (2026-09-03)

Reviewing PR #15243 (CON-230), two consecutive review passes rejected the PR claiming its artifacts
did not exist. Both were reading `/Users/jeffrey.lu/dev/writer-monorepo`, which was sitting on an
unrelated branch (`fix/con-221-...`). The code was real; the checkout was wrong. Jeffrey's correction
was emphatic and came twice: review the GitHub diff, and check the branch out in its own worktree
rather than assuming the monorepo working copy is on it.

The standing rule for any code review:

- Resolve the PR first (`gh pr view <n> --json headRefName,headRefOid,files`) and treat the head SHA
  as the only thing under review.
- Read the code at that SHA — from a worktree checked out to it, or via `gh api .../contents?ref=<sha>`
  for individual files. Confirm the worktree's `git rev-parse HEAD` equals the PR head before trusting
  anything read from it. Existing worktrees may already be at the right commit: check
  `git worktree list` before creating another.
- "The symbol does not exist in the repo" is never a finding until it has been checked at the PR's head
  commit. The default working directory is a starting point, not the subject of the review.


## <a id="25"></a>25. A screenshot may be of our own branch, not of shipped behavior (2026-09-14)

On CON-270 a screenshot of the Connect modal was cited back to Jeffrey as evidence of what the
product does today. It was not: the modal in it was the uncommitted frontend work on
`jeffrey/CON-270/basic-auth-blank-password`, and only the error inside it came from the deployed
`main` gateway. Jeffrey: "the screenshot is what WE IMPLEMENTED, NOT WHAT EXISTS."

Before treating any image Jeffrey shares as evidence, establish which build produced each part of it.
A screenshot taken against a local worktree mixes our unreleased UI with real server responses, so
the UI in it proves nothing about main while the error in it still does. Say explicitly which half is
which when describing it, and never use a picture of our own change as proof of the bug it fixes.


## <a id="26"></a>26. A PR link is the review target, not the local checkout

When Jeffrey supplies a pull-request URL, the review must be performed against that pull request's
head commit as it exists on GitHub, fetched with the `gh` CLI (`gh pr view/diff <n> --repo <owner/repo>`,
and `gh api repos/<owner/repo>/contents/<path>?ref=<head-sha>` for the surrounding files a hunk needs).
His local working tree is frequently on an unrelated branch with unrelated uncommitted changes, so
reading it produces a review of code that is not in the pull request at all. He corrected this on
2026-09-16, in strong terms, after a review of PR #5371 cited files and line numbers taken from the
local `jeffrey/CON-154/ais-password-grant` branch instead of the PR head. Never substitute the local
checkout, and never cite local paths or line numbers as evidence for a PR review.

### <a id="27"></a>27. Replay a memory-ranking acceptance query against an as-of-question copy of the database

Learned 2026-10-08 on the time-scoped retrieval task. A complaint about retrieval spawns follow-up tasks, runs, and activity about the same subject within hours. By the time the fix is tested, those newer rows dominate the replay: on the full live copy, `bd37e9e2` and this task's own work item took the top slots for "what changes to workbench memory were made". Run the replay twice. First, on a read-only `sqlite3 ".backup"` copy. Second, on a copy that deletes non-doc `memory_documents` rows (and their chunks) created after the question's timestamp. Judge acceptance on the as-of copy and report both results. Doc rows stay because their `created_at` is the file mtime. Also: in a time-scoped query, trigger words like "changes" match boilerplate such as "Integrated agent changes into ...", so they are kept out of the keyword channel.

*Provenance: 9490929d-6aaf-4722-ae78-d5d4eaabbc2b*

### <a id="28"></a>28. Counting fake-agent spawns over-counts: host respawns and the grounding call

When a test asserts "the turn ran exactly once" using a fake provider's spawn count, count turns received, not process starts. (1) The session host respawns an idle provider after a crash; that spawn executes nothing. (2) In shared-room tests the supervisor's grounding call also runs the fake claude binary with --input-format, so only spawns carrying --session-id or --resume are provider sessions. Also: the fake must emit with writeSync(1, ...) and a real "\n" before process.exit, or buffered stdout is lost and the host sees a failure with zero events, which wrongly triggers the pre-first-event fallback and masks the bug under test. Session fallback is decided by canFallBackToPerRun (shared-room.ts): false once the provider streamed its first event.

*Provenance: 102eeb91-3a84-462e-8353-77b9b56c2593*

### <a id="29"></a>29. Blocking per-run fallback is not enough: run-level transient retry can also replay a started turn

When guarding against a repeated turn after side effects, check every replay path, not just the one named. In src/server/agent-runner.ts the failure handler (~:2826) schedules a whole-run retry when RETRYABLE_KINDS.has(run.kind) && isTransientAgentError(error). The SessionTurnStartedError wrapper added in 79e8bf7 keeps the original message, so a mid-turn error that looks transient is still retried and commits/pushes can run twice. The wrapper also hides the original class from instanceof checks (ProviderRefusalError, AgentTerminalWarningError at ~:2834 and ~:2828). Also unfixed: the Claude-at-capacity to Codex fallback in runAgentCommandWithFallback. Reviewing a fix for duplicated side effects should enumerate all of: per-run fallback, transient retry, capacity fallback.

*Provenance: 73ea0400-3361-441e-bd09-323fe909e172*

### <a id="30"></a>30. App.test.tsx needs --localstorage-file under this Node; check backlog items for existing implementation

Running src/client/app/App.test.tsx on the current Node fails in afterEach (window.localStorage.clear on undefined) unless NODE_OPTIONS="--localstorage-file=<path>" is set. This is an environment issue, not a code defect. Also, `vitest -t` with a pattern that matches nothing reports all tests skipped and exits clean, so confirm the target test actually ran ("1 passed"). Backlog item 'Stop auto-following when scrolled away' (2026-09-01) was already implemented in conversation/view.tsx (jump-to-latest-button, isNearThreadBottomRef, 120px threshold) and covered by the App.test.tsx test 'autoscrolls only the message thread...'; Jump to latest scrolls but does not move keyboard focus.

*Provenance: 9ae3d893-6e3d-4cc4-802b-b37f3cc6fd24*
