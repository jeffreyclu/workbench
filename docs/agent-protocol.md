# Agent protocol

The one place the completion gates, memory contract, and handoff shape live. Every other instruction
file (`~/.claude/CLAUDE.md`, `~/AGENTS.md`, `~/.codex/AGENTS.md`, this repo's `AGENTS.md`, the runner
system contract, `~/.claude/hooks/task-gates.sh`) points here. Do not restate this text elsewhere.

## Where everything else is

| Need | Location |
| --- | --- |
| Completion gates | Below. `task-gates.sh` re-injects that section on every Claude prompt. |
| Durable lessons about working with Jeffrey, Workbench method and product | `docs/shared-memory.md` (index), topic files in `docs/shared-memory/` |
| Writer facts (team, stack, architecture, process) | `~/Documents/Workbench/notes/knowledge/index.md` |
| Assistant-facing API rules | `docs/assistant-context.md` |
| Personal voice, repo rules, worktrees, schema migrations, dev servers | Repo `AGENTS.md` and `~/AGENTS.md` |
| Runner-only rules (non-interactive, external-action guardrail, test-suite safety) | `RUNNER_SYSTEM_CONTRACT` in `src/server/agent-runner.ts` |

## Completion gates

<!-- gates:start -->
These five gates are hard preconditions, not guidance. They exist because one 41-hour, 175-message
task (2026-09-02) failed all five at once: five separate instructions had to be repeated verbatim
before they stuck, and nine of thirty "done" claims were contradicted by Jeffrey's very next message.
Each incomplete fix created the bug the next fix chased.

1. **Requirement before edit.** Before the first change, restate the ask as the observable outcome
   Jeffrey named, in his words. Build that, not the adjacent thing that looks better. When he says
   what was built is not what he asked for, that is terminal: replace it in the same reply. Never
   argue the two are equivalent, and never defend the prior build.
2. **Constraint ledger.** Every constraint stated anywhere earlier in the task still binds, including
   on turns about something else. Re-read the whole set before each report. If Jeffrey repeats an
   instruction he already gave, treat it as a defect report: name the constraint that was dropped,
   then fix it. Complying silently hides the miss and guarantees the next one.
3. **The done gate.** "Done", "fixed" and "works" are claims about Jeffrey's observable outcome, not
   about the code. Say them only when the failing path was exercised end to end in this run, at the
   surface where it failed, with the output observed. Source reading, static wiring, isolated unit
   tests, and "the code path is connected" never clear this gate. When those are all that happened,
   the only honest wording is "changed X; not verified end to end."
4. **Whole-chain revalidation.** After fixing a symptom, revalidate the entire flow: the complete
   requirement, the runtime path, the repository and branch boundary, and delivery to wherever
   Jeffrey actually looks. A fix verified only at the layer it was made in is not a fix.
5. **Evidence before questions.** Search the conversation history, `~/Documents/Workbench/notes/`, and the repository
   before asking anything. Ask only what the evidence provably cannot answer, and say what was
   searched. Asking for an example that is already in the thread is a failure, not diligence.
<!-- gates:end -->

## Memory contract

Memory is shared or it does not exist. No per-agent private memory store holds a durable lesson.

1. **Search first.** Before any non-trivial task, read the index rows of `docs/shared-memory.md`, then
   open only the topic files whose keywords match. For Writer work, read
   `~/Documents/Workbench/notes/knowledge/index.md` and the files it points to.
2. **Cite.** When a recalled lesson shapes a decision, cite it as `[file.md#N]` (topic file and entry
   number). Do not cite an entry you did not open.
3. **Record before finishing.** When Jeffrey teaches or corrects something durable, or a run learns
   something a later run would need, call the `record_learning` MCP tool before the final answer. It
   appends the entry, updates the catalogue count, and returns the `[file.md#N]` citation. Update an
   existing entry rather than adding a near-duplicate. Never record secrets.
4. **Verify before relying.** Recalled memory is evidence from when it was written. Check any named file,
   function, or flag still exists. Mark unverified claims as unverified, with source and date.
5. **Writer facts** also go to `~/Documents/Workbench/notes/knowledge/` in the same reply, so Claude
   and Codex both read them.

## Handoff shape

Every final answer and `agent_handoff` uses three sections, in this order:

- `## Problem`: what was wrong or asked, as the observable outcome.
- `## Solution`: what changed, as a list of decisions and files.
- `## Context`: what was verified and how, what was not, risks, and open blockers.

Lead with the practical result. State the exact command and observed output for every verification
claim. A run that changed client files adds a `Where to see it:` line naming the screen or route.
When the word "done" would be unearned under gate 3, write "changed X; not verified end to end."
