# Shared Workbench memory — index

This is the single durable memory for every agent working with Jeffrey — Claude, Codex, and anything
else Workbench dispatches. Jeffrey's standing instruction: **never keep per-agent private memory. Every
durable lesson, preference, and correction goes here.**

**Read this index in full, every turn.** It stays short on purpose — the actual lessons live in the
topic files under `docs/shared-memory/`. Open only the topic file(s) relevant to the current task; you
do not need to read the whole directory to act on a normal task.

When you learn something durable: append it to the right topic file below, in the same reply you learn
it — update the existing subsection rather than forking a near-duplicate. If it doesn't fit any topic
file here, create a new file under `docs/shared-memory/` and add a line for it below. Rules marked
**(always)** inside a topic file apply to every task, no exceptions. Writer product facts still also
belong in `~/notes/knowledge/` so both tools can read them.

## Topic files

- `shared-memory/working-with-jeffrey.md` — how to communicate and act: never ask clarifying questions
  and just act, never ask Jeffrey for permission grants inside Workbench, the full voice/communication
  style guide, plain-language bias in specs and replies, backend decisions are mine to make (not his to
  arbitrate), confirm ownership before picking up work he only mentioned, both assistants (Claude and
  Codex) get every fact and every tool, persist what he dumps at you in the same reply, and exhaust the
  code/docs before escalating a question to a person.
- `shared-memory/workbench-product-decisions.md` — UI/product decisions for the Workbench app itself:
  agent conversations must be visual (not text walls), restore the last-opened item per primary surface,
  the single project-color system (`ProjectColorDot`, same component everywhere), the `/api/realtime`
  WebSocket transport for cache invalidation and notifications, and Workbench as a first-class mobile
  target (no hiding whole regions at narrow widths).
- `shared-memory/workbench-operating-practices.md` — process rules for running Workbench tasks: keep
  executions short (bound the run, don't expand it), scope of "improvement" suggestions (no filters or
  saved-views, surfacing existing cost data is welcome), publish every `.md` file as an artifact,
  coordinate file writes across agents before overwriting, always close dev servers you start, never
  revert Jeffrey's live app state, his task-queue "stack" working model, automate instead of adding a
  manual-sync button, and never make him retype or let an identifier fork into spelling variants.
- `shared-memory/integration-constraints.md` — hard constraints on any new integration: one holistic
  mechanism that works for both Claude and Codex with no public-tunnel dependency IT can block, no
  enrolling his personal phone in the corporate Tailscale tailnet, and no new Slack apps (use a Workflow
  Builder webhook trigger instead).
- `shared-memory/engineering-standards.md` — standing engineering conventions: loading states must be
  skeletons that match the eventual content, not spinners or late-arriving text; the `frontend-engineer`
  implementation standards (layering, stack, plan-before-code, full acceptance-criteria test coverage);
  the `frontend-reviewer`-only code review method (reading exercise, blocking/non-blocking labels, no
  test/app execution); the Figma design-access gate (never implement from a link or screenshot); and the
  eval-cost rules — layered eval tiers instead of caps, and **never fire a billed live-agent bench run
  without Jeffrey's explicit run-specific go-ahead**; and per-turn dynamic task-kind re-inference for
  linked-conversation dispatch (a task's stored classification must not be treated as frozen for every
  future chat reply).
- `shared-memory/verification-and-debugging-method.md` — how to verify and debug rigorously: confirm
  which repo a check actually ran against before asserting git state, verify a stated rationale instead
  of inferring it, there is no recovery for edits to untracked files, edit as a single tracked worker and
  verify only from observed command output, close the exact symptom Jeffrey reported rather than
  adjacent bugs, confirm root cause against real run data instead of a plausible code-reading story, fix
  every independently-identified cause (not just the top-ranked one), land approved fixes on a new
  branch, prefer proven named methods over bespoke heuristics, trace a guardrail's origin before changing
  it, and use nvm (not mise) for the Node toolchain.
- `shared-memory/writer-context.md` — Writer-specific facts and rules: never reference PLUTO in Writer
  work, Jeffrey is on the connectors team himself (not an external party to loop in), the MCP backend
  design summary, his Claude/Codex subscription tiers, Staff-promotion meeting prep, his local dev
  workflow in `writer-monorepo` (frontend only, against the deployed dev backend, never switch him to a
  local backend), and treating terms in his meeting notes as phonetic transcription, not a vetted
  glossary.
- `shared-memory/workbench-frontend-lessons.md` — concrete Workbench frontend bug lessons: promote
  UI-visible fixes to the live runtime immediately instead of leaving them staged, a "regression test
  added" claim must be checked against what the test actually asserts, task-linked conversation controls
  stay icon-only, runtime promotion needs the `buildId` reload toast to reach tabs that were already
  open, task-card status badge placement and styling, virtualized-list row-height math must budget for
  the visual gap, stale `@media` overrides can silently regress an already-fixed style, and closing a
  task on mobile must preserve the stack route in browser history.
- `shared-memory/migration-log.md` — record of the 2026-08-23 migration that consolidated 44 files of
  private Claude memory into this shared store, and how two conflicting migrated lessons were reconciled
  rather than copied verbatim.

## Pushing is a separate instruction from the work (2026-08-28)

Jeffrey grants push/PR permission explicitly and narrowly. When he says "push" or "create a PR",
that IS explicit authorization and the agent must do it rather than claiming it cannot. But that
authorization does not carry forward: it covers the push he asked for, not the next one.

After a later, differently-scoped instruction — "audit the PR for WDS tokens", "review this",
"check X" — the deliverable is the finding plus the local edit. Do not push those edits, and do not
treat the earlier push approval as still active. Report what changed locally and let Jeffrey decide
whether it goes to the remote.

Learned when an audit-only request for PR #14774 was answered with an unrequested push of
`2b60429647` to `feat/con-connectors-v2-projection`.

## Name code with mainstream industry vocabulary, not architectural jargon (2026-08-28)

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

## Look for an existing pattern before writing new behavior

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

## Hard-flag every legacy file a new feature touches

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

## Jotai is for new components only (2026-08-28)

Jeffrey's direction on the CON-194 branch: "jotai is strictly for NEW COMPONENTS. if there's any
legacy functionality we're importing, do NOT convert those to jotai yet. but make a note of it so we
can keep track." Introducing Jotai is an additive change scoped to code the Connectors rewrite newly
owns. Shared modules that a new component imports keep their existing state mechanism, because
converting them changes behavior for legacy surfaces still rendering them. Whenever a Jotai migration
is blocked by that rule, write the blocked import down instead of converting it — the file-level
carve-out list for Manage Connectors V2 lives in `~/notes/knowledge/writer-frontend-stack.md`.

## Never post code review comments to GitHub — draft them for Jeffrey (2026-08-28)

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

## Every "done" report must say where Jeffrey can see it — or that there is nothing to see (2026-08-29)

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

## A heuristic Jeffrey cannot read on screen has not been delivered (2026-08-29)

The prior entry told me to *say* when a layer has no UI. Jeffrey's next reply made clear that saying
so is not the fix he wants: "the whole point is for me to SEE THE FUCKING HEURISTIC, SO I CAN
UNDERSTAND THE CODE." Honest reporting about an invisible layer is still an invisible layer.

The standing rule: when I build a heuristic, classifier, scorer, audit, or any deterministic rule
set, the default deliverable includes a surface that shows its actual reasoning to a reader — the
measurements it took, the rules it evaluated in order, which rule fired, and which were never
reached. Shipping it only as prompt text, a validation gate, or a one-word label is incomplete work,
not a design choice to defend. Jeffrey reads these surfaces to understand the codebase, so their
audience is him, not the model.

Build the visible trace out of the same code path that produces the verdict — make the classifier a
projection of its own explainer — so the explanation cannot drift from the behaviour. A trace
reconstructed alongside the real logic is worse than none, because it explains a verdict the
pipeline never reached.

## Visible means readable in under 100 words (2026-08-29)

The entry above is right that a heuristic needs a surface, and I over-corrected on it: I shipped the
full trace — line counts, path buckets, every rule in evaluation order, evidence hunks, the parity
axes — and Jeffrey's verdict was "this shit is not human readable. the whole point of this is for me
to able to quickly understand changes. like it can't be more than 100 words."

So the two entries compose into one rule rather than fighting: the deterministic layer must reach the
screen, and what reaches the screen must be plain-language prose a person absorbs in one glance.
Roughly 100 words is the ceiling Jeffrey named, and he meant it as a cap, not a target. When there is
more to say than fits, drop the lowest-priority sentences and keep the warnings — the reason to read
a summary at all is the part that says something is wrong. Completeness is not the goal; a complete
surface nobody reads carries no information.

This generalises past this one panel: for any explanation surface I build, prefer a few short
sentences over a table of measurements, and reach for the raw trace only when Jeffrey asks for it.

## The heuristic panel exists to price review time, not to describe the diff (2026-08-29)

Jeffrey stated the panel's purpose outright: "remember this is help me decide how much time to
dedicate to reviewing the block." That is the acceptance test for every sentence it renders. A fact
earns its place only if knowing it would change how long he spends on the block; if it would not, it
is padding no matter how accurate it is.

This supersedes the earlier instinct to spend a word budget. Filling 100 words with restatements of
the same measurement — total lines, then the file list, then the production/non-production split,
then "N of M hunks touch docs" — reads as repetition because it is one fact said four times, and
none of the four changes the time estimate. His correction was "very repetitive. i want CRITICAL
information only, with thorough explanations": fewer items, each explained deeply enough to act on,
rather than more items each stated shallowly.

The general rule for triage surfaces: state each measurement at most once, lead with the attention
call, and follow it only with findings that raise or lower the cost of reviewing — a stale verdict, a
dropped declaration, a still-referenced removal, a risk flag, an untested new symbol. When nothing
raises the cost, say that explicitly and name the checks that came back clean; "cheap to review" is
itself a critical answer.

## Paginated lists: never auto-drain, and research the server contract first

Jeffrey's correction on 2026-08-31, during the Connectors V2 manage-connectors work: when a paginated
list shows incomplete data, do not "fix" it by auto-fetching every page in a loop. He rejected both
shapes of that patch — a capped drain ("why is there a fucking cap? we're supposed to have infinite
scroll") and an uncapped one ("we can't drain the paging query"). Draining is a workaround that hides
a broken contract behind extra requests; the paging query itself has to return the correct rows.

He also drew the general method rule from the same episode: "this might need a backend refactor. i
don't know yet. research before blindly changing shit." When a data-completeness bug could originate
server-side, read the actual server contract — route handlers, query schemas, pagination limits —
before editing frontend code. In practice that meant reading `WriterInternal/be.mcp-gateway` through
the GitHub API (no clone needed), which disproved the offset-arithmetic hypothesis I was about to
implement and located the real gap in the endpoint's missing filters.

The failure mode to avoid is proposing a client-side compensation (drain, larger page size, second
query, synthesized rows) for something the endpoint cannot express. Name the backend gap and let
Jeffrey decide whether the fix belongs there.

## Audits and static analysis run against `main`, not the checked-out branch

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

## Feature-flag gates must never fall through to legacy while flags resolve (2026-08-31)

Jeffrey, on Connectors V2: seeing the legacy skeleton render before the V2 skeleton is "unacceptable".
A gate that reads `useFeatureFlag(...)` alone treats "not resolved yet" as `false`, so every V2 user
briefly mounts the legacy view — running its queries and flashing a layout V2 never shows. Gate on
flag readiness as a third `pending` state that renders the new view's own skeleton, and route every
render site that paints before the gated component (page-level tab skeletons included) through the
same hook so they cannot disagree.

## Every failed user-triggered mutation must raise an error toast

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
