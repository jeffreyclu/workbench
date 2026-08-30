# Implementation plan — Review stack (third conversation surface)

*Unified plan, 2026-08-29. Merges the Codex automation-first attention stack with the
Claude wiring analysis, under Jeffrey's queue-first correction.*

## Core principle

**The existing Changes view must not break.** It is already useful and stays exactly as
it is. The review stack is an *alternative* surface, not a replacement and not a
refactor of Changes. Every decision below is subordinate to that: where isolation and
elegance conflict, isolation wins.

## The model

```text
Prioritized semantic-block queue      ← the workflow
  → selected block
    → code analysis                   ← always
      → relationship map              ← only when the path warrants it
```

The queue is the spine. The relationship map is a critical helper Jeffrey opens on the
most important paths only — a surgeon's camera for the critical parts, not for every
step. Priority decides both token spend and visualization spend.

Tiers:

- **T0 automatic** — deterministic proof settles it. No AI, no map.
- **T1 delegated** — bounded AI judgment. No map.
- **T2/T3 human** — deep analysis *plus* the relationship map showing the selected
  block's callers, state changes, effects, tests, and risk paths.
- Any lower-tier block that discovers broader impact escalates and gains the map.

---

## Phase 0 — Stop the live Changes regression (blocking, do first)

This is not hypothetical, and it is not uncommitted scratch work: `src/shared/logic-blocks.ts`
and its wiring are **committed at HEAD** (`551b2c4 chore: commit before runtime promotion`).
It is wired into the **shared** derivation path, so Changes has already silently switched
from hunks to logic blocks:

| Site | Calls | Consumed by |
|---|---|---|
| `src/shared/review-decisions.ts:98` | `splitPatchBlocks` = `splitPatchHunks().flatMap(splitHunkIntoLogicBlocks)` | — |
| `src/shared/review-decisions.ts:243` | `buildReviewDecisions` → `splitPatchBlocks` | Changes (`workspace-diff/view.tsx:200`), server scorer (`review-auto-score.ts:91,212`) |
| `src/client/features/diff-review/logic.ts:86` | `buildFileDiffHunks` → `splitPatchBlocks` | Changes (`workspace-diff/view.tsx:18`) |

Two consequences, both violating the core principle:

1. Changes renders finer units than it did, changing the review surface Jeffrey relies on.
2. Review identity is `` `${file.path}::${patchHunk.range}` ``, and `diff_hunk_reviews`
   is keyed `(revision, file_path, hunk_range)`. Splitting changes those ranges, so
   **previously recorded hunk reviews no longer match their rows.** Existing review
   state effectively disappears.

Because it is committed and that commit was a pre-promotion checkpoint, assume it is live.
Phase 0 is a forward fix, not a working-tree revert.

**Action.** Restore the shared path to hunk-level:

- `review-decisions.ts:243` and `diff-review/logic.ts:86` call `splitPatchHunks` again.
- Keep `logic-blocks.ts` — it is a good primitive. It stops being reachable from any
  Changes or shared-scorer code path.
- Move `splitPatchBlocks` out of `src/shared/review-decisions.ts` into the new
  Review-owned module in Phase 2. Nothing in `src/shared/` may import `logic-blocks.ts`
  while that module is also read by Changes.

**Verification.** `src/shared/review-decisions.test.ts` and the workspace-diff tests
pass; `grep -rn "logic-blocks" src/shared src/client/features/workspace-diff` returns
nothing.

---

## Phase 1 — The surface

Create `src/client/features/review-stack/ReviewStackView.tsx`.

The **only** edit to existing code is the tab container,
`src/client/features/conversation/view.tsx`:

- Widen `activePane` (line 318) to `'conversation' | 'changes' | 'review'`.
- Add the third button to both tab groups (desktop line 1216, phone line 1214).
- Render `ReviewStackView` beside the existing Changes branch (line 1399), passing the
  same `workspaceDiffScope`, active workspace paths, `taskIntent`, and PR candidates.

Isolation rules:

- Review gets its **own** source and selection preference keys. Using Review must never
  move the file, scroll position, or selection inside Changes.
- Review does **not** reuse `WorkspaceDiffView`. It normalizes its source in
  `review-stack/source.ts` + `use-review-source.ts`.
- Review mounts lazily; opening it starts or recovers analysis, and closing it costs
  Changes nothing.

Exit criterion: the third tab renders an empty shell, and Changes is byte-identical in
behavior.

---

## Phase 2 — Semantic blocks (Review-owned)

Add, all under `review-stack/`:

- `review-blocks.ts` — owns `splitPatchBlocks` (moved from shared) over
  `logic-blocks.ts`. Block identity is `file path + block range + content hash`.
- `review-obligations.ts` — what must be proven about a block.
- `review-relationships.ts` — callers, state, effects, tests for a block.
- `review-routing.ts` — proof-based routing to a tier.

Over-splitting is the main failure mode; the continuation rule in `logic-blocks.ts`
(rejoining a block with its continuation) is the guard and needs direct tests.

Exit criterion: Review lists semantic blocks for a real diff. No AI yet.

---

## Phase 3 — The queue

Rank blocks by attention deserved. T0 blocks (formatting, pure renames, generated
output, import-only) auto-settle and collapse out of the way but stay reachable.

This phase replaces `src/server/review-auto-score.ts`'s role *for Review only* with a
tiered analysis queue. `review-auto-score.ts` keeps serving Changes unchanged.

**Rank quality is the entire product.** It gets its own test corpus before Phase 4.

Exit criterion: scroll, judge, advance — a complete, useful reviewer with no map at all.

---

## Phase 4 — Tiered AI depth

`src/server/review-assist-ai.ts` moves from score generation to structured block
analysis *for Review's action types only*; existing Changes actions keep their current
behavior and cache entries.

**Blocking correctness item:** tier must enter the assist cache hash. The `keyed` object
at `src/server/review-assist-ai.ts:148-150` must include the tier, or a cheap T1 skim
gets served for a T3 request wearing T3's authority. The cache is content-addressed
(`review_assist_cache`, migration `064_review_assist_cache`), so extending the hash
invalidates old entries naturally — **no migration needed**.

Escalate T1 → T3 when the model reports low confidence or names evidence it lacks.

**Built.** The tier now enters the assist cache hash *and* the prompt — keying it
without spending it differently would be two cache entries for one answer. Untiered
Changes requests append nothing, so their prompts stay byte-identical and no cached
answer is invalidated. A tiered answer signs off with `CONFIDENCE: high|low` and, when
low, a `MISSING:` line; the review stack reads that back and routes the block to T3.

Escalation is looked up at the tier the block was *first* priced at, not its current
one — a lookup keyed on the escalated tier would miss the answer that caused the
escalation and oscillate. Answers accumulate per revision, so an escalation survives
the reviewer moving to another block.

Still open: the rank-quality corpus (Risk 1). An escalated block is re-asked at T3
only when the reviewer asks again — nothing re-spends automatically.

---

## Phase 5 — The map, on demand

Only now, and only for escalated blocks. Reuse `change-map-canvas.tsx`,
`change-map-layout.ts`, `change-map-logic.ts`, and `decision-relationship-diagram.tsx`
through **new Review-owned adapters** — do not modify their existing Changes consumers.

Inside a drawn map, node identity is a *place in the system* — a module or symbol that
exists whether or not it changed — so unchanged surroundings render and the change reads
as an overlay. Risk, priority, review state, and tokens spent are toggleable overlays.

Selection stays queue-driven:

```ts
interface ReviewSelection {
  blockId: string;
  nodeId: string | null;
  relationshipId: string | null;
}
```

The queue selects; the map follows. Never the reverse.

Low-priority and auto-settled blocks never pay the map's analysis or render cost.

---

## Persistence

`diff_hunk_reviews` (migration `059_diff_hunk_reviews`) is keyed
`(revision, file_path, hunk_range)` and cannot express a sub-hunk block.

**Decision: a separate `diff_block_reviews` table**, not a `block_id` column on the
shared table. A shared table means Changes reads block rows it cannot interpret — the
exact coupling the core principle forbids.

- New forward-only migration `068_diff_block_reviews` (latest applied is
  `067_shared_turn_groundings` in `src/server/database.ts`).
- Upgrade-path test starting from a database that has recorded through `067`, asserting
  the new table exists. Fresh-database coverage alone is insufficient.
- Key on `block.id + evidenceHash`; invalidate when the block or a dependency changes.

**Accepted trade-off:** reviewing a block in Review does not mark its hunk reviewed in
Changes. Reconciling the two is a deliberate later decision, not a silent coupling.

---

## Reuse map

Imported unchanged (read-only consumers, no edits to these files):
`heuristic-panel.tsx`, `decision-detail-card.tsx`, `file-diff-pane.tsx`,
`review-actions.tsx`, `review-handoff-card.tsx`, `coverage-evidence.ts`,
`change-type.ts`, and the `DiffHunkReview*` contracts.

Forked into Review-owned modules: block splitting, decision derivation, ranking,
auto-scoring, AI assist actions.

Edited in place: **only** `src/client/features/conversation/view.tsx` (tab wiring), plus
the Phase 0 revert.

---

## Risks

1. **Rank quality** — if the ordering is wrong the product has no value. Needs a real
   corpus before Phase 4.
2. **Over-splitting** — a 20-line function shattered into eight blocks is worse than a
   hunk. The continuation rule is the guard.
3. **Drift back into shared code** — the pressure to "just reuse" the shared derivation
   is how Changes breaks. `src/shared/` stays hunk-level.

## Isolation contract (the test that governs merges)

With Review open, closed, or never mounted, Changes must produce identical decisions,
identical hunk ids, identical persisted rows, and identical AI cache hits as it does on
`main` today. Any change that cannot satisfy this belongs in Review's own modules.
