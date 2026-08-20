# Strategy: Automate durable context and memory management

Status: proposed, awaiting Jeffrey's approval
Date: 2026-08-20

## The outcome we want

Workbench should remember the handful of things that actually change how future work is
done — decisions, preferences, constraints — and forget the rest. Today it does the
opposite: it remembers everything verbatim and can't tell any of it apart.

## What's broken today (measured, not guessed)

All numbers are from the live database, read-only, on 2026-08-20.

| Problem | Evidence |
|---|---|
| Memory is a text dump | `shared_memories` has four columns: `id, kind, body, created_at` (`src/server/database.ts:138`). No project, no provenance, no lifecycle. |
| Rows are whole transcripts | 74 rows, 526 KB total. Largest single row: **92,705 characters**. |
| Selection is by recency only | `getSharedContext()` in `src/server/repository.ts` takes the 20 newest and truncates each to 2,000 chars. |
| Every prompt pays ~8.6k tokens | The current 20 rows inject **34,367 characters** into each prompt. |
| Paid three times over | Injected at task execution (`agent-runner.ts`, prompt builder), shared-room replies (`shared-room.ts`), and task drafting (`app.ts`). |
| Half of it is duplicated | Each archived task writes both a `task_archive` and a `conversation_archive`; the conversation copy repeats the same agent outputs. |
| No relevance filter | Work items carry `project_name` (14+ projects, 600+ items) but memory ignores it. A Workbench memory task receives coffee-chat prep for a connectors PM. |
| Nothing can be corrected | No API routes, no UI, no edit, no delete, no supersede. Memory is write-only. |
| A documented promise is unimplemented | `docs/assistant-context.md` says pinned lessons are injected into every prompt. `pinned` has schema, contract, and an update method — but no route, no UI, and **0 pinned rows**. `getSharedContext()` ignores it. |

There is also a **second memory system**: `~/notes/knowledge/` (17 files) plus the Claude
memory directory. Codex and Claude read those from disk; Workbench can't see them, and
they can't see Workbench. Any plan has to say which one owns what.

## The core idea

Split what is currently one step into two.

1. **Capture** — keep the full archive. It's cheap, it's already working, and it's the
   audit trail. Just stop injecting it into prompts.
2. **Distill** — a small model run turns each archive into a few short, typed facts with
   a pointer back to where they came from. Only these enter prompts.

A memory is one claim, under 800 characters, that would change what a future agent does.
Everything else stays in the archive and is fetched only when asked for.

## Design

### 1. A real memory table

Replace the four-column table with one that can answer "who said this, when, about what,
and is it still true?"

```sql
CREATE TABLE memories (
  id                     TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL,   -- decision | preference | constraint | convention | fact
  scope                  TEXT NOT NULL,   -- global | project | workspace
  project_name           TEXT,
  workspace_path         TEXT,
  title                  TEXT NOT NULL,   -- the claim, one line
  body                   TEXT NOT NULL,   -- why it holds; <= 800 chars
  status                 TEXT NOT NULL,   -- proposed | active | superseded | rejected
  confidence             REAL,
  source_work_item_id    TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  source_conversation_id TEXT,
  source_message_id      TEXT,
  source_run_id          TEXT,
  source_quote           TEXT,            -- verbatim evidence
  supersedes_id          TEXT REFERENCES memories(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  reviewed_at TEXT, last_used_at TEXT
);
```

`source_*` is the provenance requirement. Every memory links back to the task,
conversation, message, and run it came from, plus the exact sentence. That makes each
one auditable in one click and reuses the task-graph work already shipped —
memories become another node hanging off `work_items`.

Keep `shared_memories` as the raw archive store. Rename it `memory_archives` for clarity.
Nothing is deleted, ever.

### 2. Automatic extraction

**When it runs.** On task archive, and on completion of any `strategy` or `execute` run.
Not per message — that's too expensive and too noisy.

**How.** A new run kind, `memory`, on the cheapest model (Haiku). It reads the archive and
returns candidate memories as structured JSON. The prompt uses the same three-part test
already proven in the Claude memory rules: a memory must be **applicable** (it would change
future behavior), **durable** (it applies beyond this task), and **legible** (readable
without the original conversation).

**What gets trusted.** Extraction proposes; it does not decide.

- A candidate quoting an explicit instruction from Jeffrey — "always", "never", "don't",
  "from now on" — lands as `active`.
- Anything inferred lands as `proposed` and waits for review.

That asymmetry matters. A wrong memory is worse than no memory, because it silently
corrupts every prompt afterwards. But making Jeffrey approve every line would be a chore
he'd abandon, and he works from his phone. Explicit instructions from him are already
approved by definition; inferences are not.

### 3. Contradiction detection

Run on every new candidate, in two passes so we don't spend a model call per pair.

1. **Cheap shortlist.** Same scope and kind, plus meaningful word overlap in the title.
   No embedding infrastructure exists here, so this stays lexical.
2. **Model adjudication** on the shortlist only. Returns one of:
   - `duplicate` — drop the candidate, bump `last_used_at` on the existing one.
   - `refines` — new memory supersedes old; old becomes `superseded`.
   - `contradicts` — new memory supersedes old **and** raises a conflict card for Jeffrey.
   - `independent` — keep both.

**Newer wins by default.** Jeffrey's later statements override his earlier ones — the cost
telemetry work is the proof: "just remove the cost, it's irrelevant" reversed an earlier
decision within the same task. Blocking on conflicts would stall the room. Instead the
supersede happens immediately, the old row survives as `superseded`, the change is written
to the task activity feed, and Jeffrey can reverse it from the conflict card.

### 4. Scoping by project and workspace

Replace recency-20 with a budgeted selector, used by all three call sites.

Selection order:
1. Active `global` memories (cap 10)
2. Memories matching the item's `project_name`
3. Memories matching the item's `workspace_path`
4. Memories whose source task is this item's parent or a linked reference

Ranked by: narrower scope first, then kind priority (`constraint` > `preference` >
`decision` > `convention` > `fact`), then recency. Hard budget of ~2,000 tokens, and the
prompt states how many were left out rather than truncating silently.

Archives are no longer injected. In their place goes a one-line index of recent archived
task titles and their IDs. An agent that needs the full text fetches it — which is exactly
what the in-flight MCP API task should expose.

Expected effect: **~34 KB of mostly irrelevant text becomes ~8 KB of scoped, relevant text.**

### 5. Editing and superseding

Memory is useless if Jeffrey can't correct it.

API:
- `GET /api/memories` — filter by scope, project, status, kind
- `POST /api/memories` — write one by hand
- `PATCH /api/memories/:id` — edit title, body, kind, scope, status
- `POST /api/memories/:id/supersede` — replace with a new one, chain preserved
- `DELETE /api/memories/:id` — sets `rejected`; never removes the row

UI, mobile-first because that's where Jeffrey uses Workbench daily:
- A Memory panel grouped by scope, each entry showing its source task as a tappable link
- A review queue for `proposed` candidates: accept, edit, reject
- Conflict cards showing the two claims side by side with their quotes

### 6. Make pinning real, and fix the doc

Pinning a room message creates an `active` memory with full provenance to that message.
That gives us the cheapest possible manual capture path and makes
`docs/assistant-context.md` true instead of aspirational. Ship this in Phase 1.

### 7. Two memory stores, one rule

- **Workbench memories** own how work gets done here: decisions, preferences, conventions,
  process constraints.
- **`~/notes/knowledge/`** owns durable Writer domain facts, because Codex reads those files
  and can't read this database.

No two-way sync — that's fragile and will drift. When extraction produces a domain fact
about Writer, it stores a short summary plus a pointer to the knowledge file, and the file
stays the source of truth. One direction, one owner per fact.

## Phasing

| Phase | Work | Size |
|---|---|---|
| **0 — stop the bleed** | Drop the duplicate conversation archive from injection, cap the context budget, correct `assistant-context.md`. No schema change. | Half a day |
| **1 — structure** | New `memories` table, provenance columns, scoped retrieval, read/edit API, memory panel, real pinning. Existing archives stay untouched. | 2–3 days |
| **2 — extraction** | `memory` run kind, distillation prompt, proposed/active gating, review queue. | 2 days |
| **3 — conflicts** | Shortlist + adjudication, supersede chains, conflict cards. | 1–2 days |
| **4 — reach** | Knowledge-file pointers, memory access through the MCP API. | 1 day |

Phase 0 delivers most of the token savings on its own and is safe to ship alone.

## Risks and how we handle them

- **A bad memory poisons every later prompt.** Worse than having none. Handled by:
  proposed-by-default for inferences, a verbatim quote on every row so any claim can be
  checked, and an environment kill switch that disables injection entirely.
- **Prompt injection through memory.** A memory extracted from fetched web content or file
  output could carry instructions. Handled by: extracting only from Jeffrey's messages and
  agents' own final outputs — never from tool results — and rendering memories inside a
  clearly fenced data block in the prompt.
- **Extraction cost.** One model run per archive. Handled by: cheapest model, and firing
  only on archive and on strategy/execute completion.
- **Recency-wins drops a rule that was still valid.** Handled by: never hard-deleting,
  keeping superseded rows queryable, and logging every supersede to the activity feed.
- **Back-filling 74 existing archives.** Handled by: lazy, offline back-distillation as a
  manual command. Never on boot — boot must stay fast and must not call a model.

## Acceptance criteria

1. A prompt built for a Workbench task contains no memory scoped to an unrelated project.
2. Injected memory context stays under the configured token budget, and the prompt names
   the number of memories omitted.
3. Every memory row exposes its source task, conversation, message, and verbatim quote
   through the API.
4. Archiving a task with an explicit instruction from Jeffrey produces an `active` memory;
   an inferred claim from the same task produces a `proposed` one.
5. Extracting a memory that contradicts an active one in the same scope marks the old row
   `superseded`, links `supersedes_id`, and writes an activity entry.
6. Editing a memory through the API changes what the next prompt contains.
7. A rejected memory never appears in any prompt and its row still exists.
8. Pinning a room message produces an active memory whose provenance points at that message.
9. Existing `shared_memories` rows survive the migration unchanged and remain retrievable.

Each criterion maps to a test before the phase that introduces it is considered done.

## What this does not cover

- Embedding or vector search. Lexical shortlisting is enough at this scale; revisit past
  a few hundred memories.
- Sharing memory across machines or users. Single-user, single-database, as today.
- Automatic writes into `~/notes/knowledge/`. Workbench proposes; a human or an agent
  edits the file.
