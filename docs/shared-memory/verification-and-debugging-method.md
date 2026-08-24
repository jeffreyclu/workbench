## Verification and debugging method

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

### Check a diff against the original scope before reporting it done

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

### Reset incomplete work before rebuilding it

On 2026-08-24, after the Pluto RAG guardrail/eval diff was shown to be incomplete against its stated
scope, Jeffrey directed: "let's clear the current dif and start fresh." When that instruction is
explicit, first enumerate the tracked and untracked files in the working tree, then discard that exact
set and verify the branch is clean. Do not salvage partial scaffolding or resume implementation from
it. The clean branch is the starting point for a new, fully scoped design; it does not authorize live
bench runs or provider spending.

### Node toolchain: nvm, not mise

Jeffrey manages Node with **nvm** plus the official nodejs.org `.pkg` installer. Offered mise — which
would have matched `writer-monorepo/mise.toml` exactly — he declined it and asked specifically for nvm.
Reach for nvm commands rather than proposing mise, Homebrew, asdf, or volta.

One consequence worth remembering: `~/dev/writer-monorepo/mise.toml` pins node 22.19.0, python
3.12.13, uv 0.11.26, and installs pnpm via a postinstall hook. Because he is not using mise, those
versions are **not** applied automatically — matching the pinned node version and obtaining pnpm,
python 3.12, and uv has to happen by hand. Flag that gap rather than assuming his environment matches
the repo's declaration.
