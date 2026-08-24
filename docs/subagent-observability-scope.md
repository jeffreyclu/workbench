# Scope: observed subagent work

Workbench currently trusts Claude's word about what its subagents did. This scope closes that with
observation instead of obligation.

## The gap, precisely

`--forward-subagent-text` forwards a subagent's **text and thinking** as assistant/user events tagged
with `parent_tool_use_id`. `readableAgentEvent` in `src/server/agent-runner.ts` attributes those to
the worker that produced them. That is everything a subagent *says*.

It is not what a subagent *does*. A subagent's own `tool_use` events are not forwarded, so a file
written by a subagent never becomes an `agent_file_write` row in `audit_log`. Today the only thing
standing between "a subagent edited 14 files" and Workbench's record of it is a sentence in
`CLAUDE_EXECUTION_CONTRACT` asking the parent to report honestly. That is an obligation, not a
control, and it is exactly the class of claim that has been wrong before.

## Definition of done

For any run that delegates, all four hold:

1. Every file a subagent creates, edits, or deletes appears in `audit_log` attributed to that
   subagent's `agent_type`, not to the parent.
2. Every command a subagent runs appears in `audit_log` with its exit status, attributed the same way.
3. The set of files changed on disk during the run reconciles against the audit trail. Any file
   changed with no corresponding audit row is surfaced as an unattributed write, not silently dropped.
4. A run whose report claims a verification command passed with no matching observed command in the
   audit trail is marked **unverified** in the UI.

Criterion 3 is the one that makes this robust: it does not depend on the provider telling the truth,
or on any hook firing.

## What is verified, and what is not

Verified by reading the installed CLI bundle (`~/.local/share/claude/versions/2.1.240`) on 2026-08-23:

- `--include-hook-events` exists and emits hook lifecycle events into the `stream-json` output.
- `--settings <file-or-json>` accepts a path **or a raw JSON string**, so Workbench can inject hooks
  per invocation without touching `~/.claude/settings.json`. Jeffrey's user settings define no hooks
  today, so nothing collides.
- Hook input schemas:
  - `PreToolUse`: `{hook_event_name, tool_name, tool_input, tool_use_id}`
  - `PostToolUse`: `{hook_event_name, tool_name, tool_input, tool_response, tool_use_id, duration_ms}`
  - `PostToolUseFailure`: adds `{error, is_interrupt}`
  - `PostToolBatch`: `{tool_calls: [...]}` — fires **once per batch**, not per tool
  - `SubagentStop`: `{stop_hook_active, agent_id, agent_type, agent_transcript_path, last_assistant_message}`
  - Common base for all of them: `{session_id, transcript_path, cwd, prompt_id?}`
- Hook matchers are tool-name patterns (`"Write|Edit"`, `"Bash"`).

**Not verified, and it decides the design:** whether `PreToolUse`/`PostToolBatch` hooks fire inside a
subagent's context at all, and if they do, whether their `session_id`/`transcript_path` identifies the
subagent rather than the parent. The hook base carries no `agent_id`. This could not be tested in the
authoring session because nested `claude -p` invocations are blocked there. **Phase 0 settles it before
any implementation begins.**

`SubagentStop` is the exception: it carries `agent_id`, `agent_type`, and `agent_transcript_path`
explicitly, so it is a subagent-scoped event by construction. The primary design leans on it.

## Design: three layers, independent failure

### Layer 1 — subagent transcript ingestion (primary)

One `SubagentStop` hook per subagent. Its payload names `agent_transcript_path`; Workbench reads that
transcript and ingests every tool call it contains into `audit_log`, attributed to `agent_type`.

Why this is the primary: it fires once per subagent rather than once per tool, it is guaranteed to be
subagent-scoped, and the transcript is the subagent's complete record — every tool call, input, and
result, including work the subagent chose not to mention in its summary.

Cost: attribution lands at subagent completion rather than live. Live visibility stays with the
forwarded-text path already shipped.

### Layer 2 — per-tool hook events (only if Phase 0 says yes)

If subagent-context hooks fire and are attributable, add `PostToolBatch` (not `PostToolUse` — batch
fires once per batch and cuts process spawns by roughly an order of magnitude) for live attribution
during long subagent runs.

Transport, in preference order:
1. **`--include-hook-events`**, if the flag emits the payload into the existing stdout stream. No new
   endpoint, no new auth, no process-per-tool, and the runner already parses that stream.
2. **Hook command POSTs to a loopback ingest endpoint** (`POST /api/agent-events`) if the flag alone
   does not carry the payload. Costs a process spawn per batch and needs a per-run credential — see
   Robustness below.

### Layer 3 — filesystem reconciliation (independent of the provider)

At run start, record the workspace's git status. At run end, diff it. Every changed path is matched
against audit rows; unmatched paths are recorded as `agent_file_write` with detail `unattributed`.

This is the layer that satisfies "absolutely robust": it holds when hooks are misconfigured, when the
CLI changes its schema, when a subagent shells out to `sed -i`, and when the parent's report is simply
false. Layers 1 and 2 give attribution; layer 3 gives ground truth.

## Phase 0 — the spike that decides the design

Not optional, and nothing is built before it lands. Roughly half a day.

1. Write a settings JSON with `PreToolUse`, `PostToolBatch`, and `SubagentStop` hooks whose command
   appends its stdin payload to a scratch file.
2. Run `claude -p` against a throwaway directory with `--settings <that json> --include-hook-events
   --output-format stream-json --verbose`, with a prompt that forces one delegation and a file write
   inside the subagent.
3. Answer, from the captured stream and the scratch file:
   - Do `PreToolUse`/`PostToolBatch` fire for tools invoked **inside** the subagent?
   - Does their `session_id` or `transcript_path` differ from the parent's, i.e. is attribution
     possible without `agent_id`?
   - Does `--include-hook-events` place the full payload in stdout, or only a lifecycle marker?
   - Does `SubagentStop` fire, and is `agent_transcript_path` readable and complete?

**Decision rule:** all four favourable → Layers 1+2+3. `SubagentStop` alone works → Layers 1+3, and
Layer 2 is dropped rather than approximated. Nothing fires → Layer 3 only, and the honest answer is
that subagent attribution is not available from this CLI version.

## Work breakdown

| # | Work | Files | Size |
|---|---|---|---|
| 0 | Spike above | scratch only | 0.5d |
| 1 | Run-scoped settings JSON injected via `--settings`, built per invocation | `agent-runner.ts` (`commandFor`), new `agent-hooks.ts` | 0.5d |
| 2 | `SubagentStop` ingestion: parse transcript, emit attributed audit rows | `agent-hooks.ts`, `agent-runner.ts`, `repository.addAuditEntry` | 1.5d |
| 3 | Migration: `audit_log.category` CHECK currently rejects anything outside six values. Adding `agent_delegation` and `agent_command` needs a table rebuild + upgrade test | `database.ts` (migration 027), `contracts.ts` | 0.5d |
| 4 | Layer 3 git reconciliation at run boundaries | `agent-runner.ts`, new `workspace-diff.ts` | 1d |
| 5 | `verificationObserved` flag + unverified badge (item 6 from the earlier review) | `repository.ts`, `contracts.ts`, `App.tsx` | 1d |
| 6 | Layer 2 live attribution, **conditional on Phase 0** | `agent-hooks.ts`, `agent-runner.ts` | 1d |
| 7 | CLI compatibility test that fails loudly when the hook schema drifts | `agent-hooks.test.ts` | 0.5d |

**5–6.5 days**, depending on the Phase 0 branch.

Item 3 is the one that touches live data. It rebuilds a CHECK-constrained table, so it follows the
standing migration rules: forward-only, upgrade test starting from a database that has recorded 026,
and validation against a copy of the live database before promotion.

## Robustness requirements

These are the requirements that make this "absolutely robust" rather than "mostly works":

- **Hooks fail open, always.** A `PreToolUse` hook can *deny* a tool call. A broken or slow hook must
  never block, delay, or fail a run: every hook command exits 0 unconditionally, writes nothing to
  stdout that the CLI could read as a decision, and is wrapped so a missing interpreter is a no-op.
  This gets an explicit test.
- **No secrets through the environment.** `agentSubprocessEnv` deliberately allowlists a short list of
  env vars so Workbench secrets never reach an agent process. If Layer 2 needs a loopback POST, the
  credential is a per-run nonce embedded in the run-scoped settings JSON, not a new env var, and the
  ingest endpoint binds to `127.0.0.1` and accepts only that nonce for that run.
- **Bounded volume.** `PostToolBatch` over `PostToolUse`; ingestion writes audit rows in one
  transaction per subagent; the existing `runRetentionCleanup` covers growth. A single run must not be
  able to write unbounded audit rows — cap per run and record the truncation rather than dropping it
  silently.
- **Isolation from Jeffrey's own sessions.** Hooks are injected per invocation via `--settings`. They
  never touch `~/.claude/settings.json` and never apply to interactive sessions.
- **Version pinning with a loud failure.** Everything here reads an undocumented internal schema of CLI
  2.1.240. A compatibility test asserts the parsed shape of each hook payload; when the CLI changes,
  that test fails with a clear message instead of attribution silently going quiet.
- **Silence is a finding.** If a run delegates and no subagent audit rows arrive, that is surfaced on
  the run, not treated as "no work happened."

## Risks

| Risk | Mitigation |
|---|---|
| Subagent hooks don't fire at all | Phase 0 finds out before any code is written; Layer 3 still delivers criteria 3 and 4 |
| Parallel subagents edit the same files in one tree — the workspace lease is per run, not per subagent | Out of scope to fix here; Layer 3 makes the collision *visible*. Serializing writers within a run is a follow-up |
| Hook process spawn adds latency to every tool batch | `PostToolBatch` not `PostToolUse`; measure in Phase 0 and drop Layer 2 if the cost is real |
| Transcript path unreadable (permissions, cleanup, race) | Ingest failure is logged as a diagnostic and surfaced on the run; never fails the run |
| CLI schema drift | Compatibility test, item 7 |

## Non-goals

- Changing how subagents are spawned, or limiting how many.
- Sandboxing subagents or restricting their tools.
- Live streaming of subagent tool calls if Phase 0 shows the events aren't attributable — an
  approximation is worse than an honest gap.
- Reworking the workspace lease to cover individual subagents.

## Verification

- Unit: hook payload parsing, transcript ingestion, attribution mapping, fail-open behavior.
- Integration: a fake `claude` that emits a delegation, a `SubagentStop` with a transcript fixture, and
  a file write — assert the audit rows land attributed to `agent_type`.
- Reconciliation: a run that writes a file via a path the audit trail does not know about must produce
  an `unattributed` row.
- Migration: upgrade test from a database recorded through 026, plus a run against a copy of the live
  database before promotion.
- End to end: one real delegating run against a scratch repository, with the audit trail compared by
  hand against `git status`.
