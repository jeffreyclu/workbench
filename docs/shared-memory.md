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
  without Jeffrey's explicit run-specific go-ahead**.
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
