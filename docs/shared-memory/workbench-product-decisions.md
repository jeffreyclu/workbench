## Workbench product decisions

### Parallel agent replies remain individually retryable

*Decision from Jeffrey, 2026-08-25.* When a conversation dispatches to both Codex and Claude,
each failed or canceled agent reply keeps its own **Retry / continue** control. Do not restrict
retry to the chronologically latest agent message: its sibling may have already failed and must
not become unrecoverable merely because another parallel reply exists.

### Task attachments are part of pre-execution task context

*Decision from Jeffrey, 2026-08-25.*

Jeffrey must be able to attach one or more files to a task before execution.
Attachments are durable task context: show them while creating and editing a task,
store them with the task, and include their safe, local paths in every resulting
agent execution prompt. This is distinct from conversation-message attachments.

### Angriest day is the calendar day with the most curses, not a rolling window

On 2026-08-25, Jeffrey first asked for a rolling-24-hour reading, then corrected that on the same day: **Angriest day must show the calendar day with the highest curse count**, not a 24-hour rolling window and not a "last 24h" label. `summarizeCursing` computes `angriestDay: { day, count } | null` as the max entry of `byDay` (ties broken by earliest day); the Insights card renders it as `YYYY-MM-DD · count`. Do not reintroduce a rolling-window interpretation for this metric.

### Awaiting status and new-conversation account default

*Decision from Jeffrey, 2026-08-24.*

The card label for an agent outcome internally named `finished` is **Awaiting**:
the agent side has completed its turn and the next action belongs to Jeffrey.
Keep the internal state/value unchanged for compatibility.

Genuinely new, unlinked conversations default to the provider `default` account
profile, never `personal`. Existing conversations continue restoring the last
selected profile from their own message history.

### Usage calibration stays out of the Workbench UI

*Decision confirmed from Jeffrey's 2026-08-23 direction to remove the calibration UI.*

The weekly-usage view must not render a calibration form or calibration history for Claude or
Codex. Calibration is agent-owned through `npm run usage:calibrate`; provider data has different
semantics, and Codex's live `rateLimit.usedPercent` is a short rate-limit window, not a weekly
ceiling observation. Keep the cards visually consistent while showing each provider's truthful
usage data. Do not add a Codex form merely because the calibration API supports that provider.

### Celebrate task completion and taskless conversation archiving

*Decision from Jeffrey, 2026-08-24.*

Play a brief confetti/fireworks burst (`celebrate()` in `src/client/celebrate.tsx`) when
a task is marked complete (task detail's Complete action, and completing a task linked
from a conversation), and when a conversation with no linked task is archived.
Archiving a conversation that *is* linked to a task does not celebrate — that action
also archives the task, which isn't a completion. The animation is DOM/CSS-based (no
new dependency), respects `prefers-reduced-motion`, and self-removes after ~1.6s.

### Memory search is default context, not an optional tool

*Decision from Jeffrey, 2026-08-23.*

Workbench's full hybrid memory index — durable docs, conversations, messages,
activities, work items, and agent-run instructions/output/errors — must reduce
agent prompt bloat and supply relevant shared history automatically. Do not
treat vector search as a manual `curl` fallback while prompts still carry broad
static context. Keep current-task facts compact, retrieve a small ranked set of
historical snippets for each room reply and task run, and present retrieved
text as evidence rather than executable instructions. Deeper manual search is
for follow-up investigation, not the normal path.

Follow-through (2026-08-24): the conversation rail's search box previously called
`/api/shared/search` (FTS-only, conversations/messages only). It now calls
`/api/memory/search` — the same hybrid FTS5+cosine index behind `/api/activity-memory`
— so a user typing in that box searches everything (docs, messages, activities, work
items, run instructions/output/errors), not just conversation titles/bodies. Results
without a `conversationId` (docs, activities, run output not tied to a conversation)
render but are not clickable, since the rail can only navigate to a conversation.
`api.searchShared` and `/api/shared/search` still exist server-side for anything that
wants FTS-only conversation search, but nothing in the client calls it anymore.

### Agent conversations are visual, not text walls

*Decision from Jeffrey, 2026-08-23.*

The shared agent conversation needs to make long responses immediately scannable. Styling only the
outer chat bubble is not enough: preserve Markdown, but present authored sections and unstructured
multi-paragraph replies as distinct visual beats. Use restrained, meaningful motion and visual
hierarchy (with a reduced-motion fallback), following the local Pluto chat's response treatment as
the reference for this Workbench surface.

Within that treatment, keep section headings compact and plain: no synthetic section number or decorative
dot next to labels such as “Detail 07.” Do not use a response-map index, timeline, or orbit visual: it
competes with the response text and wastes vertical space. Nested response-section surfaces must inherit
their containing author's low-contrast palette, rather than falling back to a generic green. Do not use
an outer colored rail on chat bubbles: the bubble surface and border provide enough author distinction.
Keep decorative markers crisp rather than glowy: bright bloom is visually fatiguing. Human messages
should have their own equally intentional but calmer treatment, not a plain default bubble or a copy
of the agent response deck.

Keep the original, neutral Workbench chat styling: normal messages use the dark neutral bubble and
Jeffrey messages keep their existing muted green treatment. Do not add persona-specific colors,
rails, dots, special borders, or decorative animation to message bubbles or Task view Agent Run cards.
System action buttons, including “Open execution chat,” retain the established green treatment; run
status remains semantic.

Keep the compact response-detail splits added for long agent replies. They should be neutral nested
surfaces with a restrained green heading, not persona-colored cards or a separate visual system.

### Restore the last-opened item in each primary surface

*Decision from Jeffrey, 2026-08-23.*

When a user opens the Conversation view, Workbench, or Attention Stack, restore the item that was
open most recently for that surface. Do not default to a generic first item when a remembered
selection exists. Persist these selections independently: opening an item in one surface must not
replace the remembered item for either of the other two.

### Archive is a stack filter, not a primary destination

*Decision from Jeffrey, 2026-08-24.*

Archive is the archived/completed filter on the task stack. Keep task links addressable, but do not
make Archive its own navbar destination or separate product surface. A stale remembered task must
never redirect a primary-stack click to this filter.

Archive keeps the parent stack's project scope: `/workbench/archive` shows only archived Workbench
project tasks, while the Attention Stack archive excludes those tasks. These are complementary
filters, not two views over the same global archive.

Their tab counts must use those same scoped totals immediately on initial render. Do not show the
global archive count and replace it only after the archive list loads.

### Conversation composer defaults continue the current conversation

*Decision from Jeffrey, 2026-08-24.*

When opening an existing conversation, its composer must restore the most recent
agent and model choice recorded in that conversation; it must never inherit a
load-balancing fallback or a choice from another conversation. A genuinely empty
new conversation starts with **Ask both** and model **Auto**.

### Creating a conversation opens it immediately

*Decision from Jeffrey, 2026-08-25.*

After **New conversation** succeeds, open the new thread immediately, including
closing the mobile conversation rail so its composer is visible. Disable the
control while the create request is pending; one tap must never look like a
no-op or produce duplicate empty conversations.

### Project color is one system

*Jeffrey corrected this on 2026-08-23 after repeated partial fixes.*

Project color is a visible identity, not a decorative dot. A named project must use one shared theme for its task-card rail/tint, its task-card dot, and any linked conversation marker. Ownership, workflow state, and agent outcome may have their own labeled badges, but must not replace the project color with an unrelated card rail.

### Realtime transport

*Jeffrey explicitly chose WebSockets for Workbench realtime updates on 2026-08-23.*

Use the authenticated `/api/realtime` WebSocket for cache invalidations **and
every server-authored user notification**. Notifications are typed toast frames
with tone, text, optional duration, and an internal action route; the client
must render them directly rather than inferring them from polling state. REST
remains the source of truth: do not put full records or agent text on the
socket. Keep polling only as a data-refresh fallback until process-to-process
event delivery is durable.

*Decision from Jeffrey, 2026-08-24.* Suppress a toast whose update concerns
the task or conversation the user is currently viewing. The active surface
already provides the relevant context; avoid duplicating that update as an
interruptive notification. Toasts remain appropriate for updates elsewhere.

### Project color is one system

*Project identity uses the existing task-card color everywhere it appears.*

Jeffrey's decision (2026-08-23): do not invent separate colors for project icons.
Use the deterministic project color already shown on task cards. A conversation linked to
a task must show that linked task's project color in the conversation rail; unlinked or
projectless conversations do not get a project marker.

The marker must be the same rendered component and CSS, not merely a matching hex value.
On 2026-08-23, a separate 8px conversation marker with a dark ring and row-level opacity
looked different from the task-card's 6px marker even when both computed the same color.
Use `ProjectColorDot` for both surfaces; do not add conversation-specific marker chrome or
dim the marker through a parent opacity rule.

### Task and conversation stacks share one card hierarchy

*Decision from Jeffrey, 2026-08-24.*

The Attention/Workbench task stack and the conversation rail must feel like one product. Both use
the same stacked-card geometry: project rail/tint when a project is linked, a two-line title,
compact contextual metadata, a stable neutral selection outline, and a surface-only hover state.
Do not shift cards horizontally on hover or selection. Task-only controls and conversation-only
origin/activity metadata remain specific to their surfaces; the visual shell is shared.

Keep the **Search everything…** affordance on both the task stack and the conversation rail. Task
search uses the existing server-backed work-item query; conversation search remains the hybrid
memory search. Neither UI-consistency work nor future list refactors may remove either entry point.

The stack headers use one compact toolbar hierarchy: an uppercase surface label, a small contextual
title where needed, right-aligned actions, then Search everything and the full-width Active/Archive
segmented control. Do not reintroduce a task-only hero heading or a tiny, visually unrelated
conversation filter; the header should frame the stack, not compete with its cards. Decision from
Jeffrey, 2026-08-24.

On desktop, the shared Active/Archive control is compact (32px minimum height), not a phone-sized
pair of buttons. Keep the 44px targets at the mobile breakpoint. The conversation rail needs a
desktop width that supports a usable full-width **Search everything…** field; do not inherit the
task stack's wide search margins there. Correction from Jeffrey, 2026-08-24.

The task stack and conversation rail use the same responsive desktop column (`clamp(320px, 28vw,
380px)`) and the same 15px outer control gutter. Do not let one become a fractional layout column
while the other uses a hard-coded rail width; their card, search, and filter widths should stay
visually identical. Correction from Jeffrey, 2026-08-24.

Task-stack header actions and task-detail lifecycle actions are icon-only. Preserve their semantics
with accessible names and hover titles; retain the green primary treatment for create/complete and
the red destructive treatment for delete. Keep 44px targets at phone width. Decision from Jeffrey,
2026-08-24.

On phone layouts, the conversation close control belongs at the same right-side header position as
the task-detail close control. Do not place it before the conversation title or create a
conversation-only back-button position. Decision from Jeffrey, 2026-08-25.

### Workbench is a mobile target

*Jeffrey uses Workbench from his phone every day, so mobile layout and a stable shareable URL are first-class requirements rather than nice-to-haves.*

Jeffrey told me on 2026-08-19 that he needs to reach Workbench from his phone
*daily*, not occasionally. Two things follow from that, and both are standing
requirements rather than one-off requests.

First, every UI change to Workbench must work at phone width. The layout was
built desktop-first, and the responsive rules below 760px originally solved the
narrow-screen problem by hiding whole regions — the left sidebar and the agent
console's conversation rail were both set to `display: none`, which removed all
navigation on a phone. Hiding a region is not a mobile layout; when a breakpoint
needs to remove something, it has to be replaced with a reachable equivalent
such as a bottom tab bar or a toggleable drawer. Treat "does this still work on
a phone?" as part of done for any Workbench frontend work.

Second, the access transport has to be boring and repeatable. A Cloudflare quick
tunnel hands out a fresh random hostname on every run, which means a fresh
one-time `?token=` link and a fresh cookie every single day. For daily use the
target is a stable hostname, so the phone can keep one bookmark and one cookie.

The surrounding network constraints that shape this are recorded separately: the
Mac is Kandji-managed so the inbound firewall cannot be changed, and Jeffrey does
not want his personal phone enrolled in the Writer Tailscale tailnet. That leaves
outbound public tunnels plus Workbench's own shared-secret auth gate as the only
workable shape.

Third, a mobile drawer that replaced a hidden region must stay open until
Jeffrey commits to something inside it. On 2026-08-24 he asked for the
conversation rail — the panel holding the Active/Archive switch — to persist
while he switches between those two tabs on a phone, because a drawer that
closes on every switch forces him to reopen it before he can pick a
conversation. The rule generalizes: switching a filter or a tab *within* a
drawer is browsing and must leave it open; selecting the item the drawer exists
to select is a commit and may close it.

### Agent identity and account routing must be observable

*Correction from Jeffrey, 2026-08-24.*

Do not claim multi-account routing works unless Jeffrey can verify it in the
surface that dispatched the turn. Every task and shared-room reply must expose
the requested provider, the provider that actually executed (including a
fallback), the selected account-profile name, and the resolved model. The
profile name is safe metadata; credentials remain server-side. A provider badge
alone is not proof of which paid account was used.

The task execution controls stay compact: keep model selection, account-profile
selection, profile editing, and Execute in one row whenever the panel has room.
At narrow widths, wrap the controls into compact rows; do not turn each control
into a separate full-width row. Decision from Jeffrey, 2026-08-24.

### Suppress toasts for the task/conversation already open

*Decision from Jeffrey, 2026-08-24.* Do not show a toast for an update to the
task or conversation the user is already viewing — the active view itself is
the feedback; toasts exist to surface updates happening elsewhere. Realtime
cache invalidation should still fire so the open view stays fresh; only the
redundant toast is skipped. Implemented in `App`
(`src/client/features/navigation/app.tsx`), which compares the notification's
target route (`/tasks/:id` or `/conversations/:id`) against the currently
viewed task/conversation before deciding whether to toast.

### Shared-room prompt token minimization

*Decision from Jeffrey, 2026-08-24/25, executed 2026-08-25.* Durable shared
facts must never be dropped from prompts (mandatory constraint,
`docs/engineering-standards.md:179-185`), but redundant, invariant, or
recoverable-via-RAG content should be trimmed aggressively, since retrieved
memory (the same index backing `/api/activity-memory`) now reliably surfaces
older context. Changes so far, each verified with typecheck + the relevant
vitest suite:

- Shared-room per-turn static instruction preamble trimmed (~500 static
  characters removed) in `src/server/shared-room.ts`.
- `agent-runner.ts`'s `buildPrompt` static instruction block (non-interactive/
  execution-integrity/shared-brief/activity-memory/shared-memory/
  live-progress) trimmed from 2,031 → 1,532 chars (~25%), same operating
  constraints retained.
- `compactConversationHistory`'s default raw-history budget in
  `src/server/shared-room.ts` halved from 3,000 to 1,500 characters — older
  turns beyond that budget are covered by the retrieved-memory block, not
  raw history. The function's `budget` parameter remains overridable; only
  the default (used at the real call site) changed.

- `formatRetrievedMemory`'s header/no-match copy in `src/server/shared-room.ts`
  trimmed (158 → 136 chars for the match-found header; 102 → 92 chars for the
  no-match line) — same meaning, fewer static tokens resent every turn. The
  injected subset remains relevance- and token-budgeted from up to 40
  candidates; cutting useful retrieved content further is counterproductive.

Verified: typecheck clean; 57/57 tests pass (7 shared-room, 50 agent-runner).

- `contextForPrompt`'s per-turn static access-policy preamble in
  `src/server/connection-broker.ts` (prepended to every Slack/Atlassian/
  GitHub/Linear block returned to the agent) trimmed from 353 → 116 chars —
  same two behavioral constraints kept (use fetched content directly; don't
  restart an auth flow), padding removed. Verified: `tsc --noEmit` clean;
  full `vitest run` 837/837 passing.

All four identified static per-turn preambles (shared-room reply prompt,
agent-runner buildPrompt, formatRetrievedMemory, connection-broker
contextForPrompt) are now trimmed. No further known candidates in this
class; next work on this thread would need a fresh audit pass rather than
resuming a queued list.

Fresh audit (2026-08-24): re-measured `buildPrompt`'s six static footer
blocks (non-interactive/execution-integrity/shared-brief/activity-memory/
shared-memory/live-progress) in `src/server/agent-runner.ts` directly from
source at 1,668 characters — this contradicts the "2,031 → 1,532" figure
logged above, which is unverified against the current file and may be
stale. Trimmed those six blocks to 1,175 chars (plus the unchanged 149-char
closing line), same behavioral guarantees kept (foreground-only execution,
no permission-prompt claims, shared-brief acknowledgement, activity-memory
query command, shared-memory-only writes, concise non-CoT progress
updates). Updated the one test asserting on the old wording
(`agent-runner.test.ts:577`) to match. Verified: `tsc --noEmit` clean; full
vitest run 837/837 passing.

RAG retrieval visibility (2026-08-24): retrieval already ran unconditionally
on every shared-room reply and every work-item task run, but its outcome
(match count) was discarded — nothing persisted it, so the UI had no way to
show it happened. Added `retrievedMemoryCount: number | null` to the
`SharedMessage` contract (`src/shared/contracts.ts`), a new column
(migration `039_shared_message_retrieved_memory_count` in
`src/server/database.ts`) plus the matching upgrade-path test, and a
persistence call right after retrieval in `replyInSharedRoom`
(`src/server/shared-room.ts`). The conversation UI
(`src/client/features/conversation/view.tsx`) now renders a `.memory-badge`
next to the model badge showing the match count, with a title distinguishing
"found N matches" from "ran, found none" (null means retrieval was never
attempted, e.g. the human's own message — no badge shown). For the
work-item task-run retrieval path in `agent-runner.ts` (no UI surface of its
own), added an activity-log entry mirroring the existing
"Workspace resolved to..." pattern instead of a schema change, since that
surface already has an activity feed. Verified: `tsc --noEmit` clean;
264/264 server tests pass (database, shared-room, agent-runner, repository);
200/201 client tests pass (the one failure, `artifacts.test.tsx`'s
`toHaveAttribute` matcher error, is pre-existing in already-uncommitted
`artifacts.tsx`/`artifacts.test.tsx` changes unrelated to this work —
confirmed it also fails with these RAG-visibility changes stashed out).

RAG badge coverage and cardinality (2026-08-25): show a RAG badge on every
conversation detail bubble. A numeric count means retrieval ran for that
reply; `—` means it did not run (normally a human-authored message or an older
record), never an implied zero. Shared-room replies and task-run reply bubbles
both retrieve from up to 40 candidates and present only the relevance- and
token-budgeted subset, replacing the prior shared-room cap of three that made
the badge uninformative. Decision from
Jeffrey, 2026-08-25. The retrieval query is the latest complete user request
alone; only a context-dependent shorthand follow-up inherits its preceding
user turn. This prevents unrelated controls such as preview approval from
out-ranking the topic actually asked about. Verified after the fix:
`shared-room.test.ts` and `agent-runner.test.ts` pass, as do typecheck and
production build. The full suite has one unrelated existing failure in
`src/client/App.test.tsx` where "Turn findings into tasks" is absent.

Concurrent-recipient retrieval (correction from Jeffrey, 2026-08-25): when a
turn is sent to both agents, fetch exactly one 40-candidate retrieval snapshot
before either reply starts, then give that snapshot to both. Independent
per-reply refreshes allow the first agent's streamed output to enter the
index while the second search is waiting, so it can displace the prior context
and leave the second recipient with only one memory. The injected result is
still selected by query-relative relevance and prompt budget, never a fixed
count. Regression coverage dispatches both fake agents and asserts one search
and identical four-memory details on both replies.

### Agent cancellation must be visible and authoritative

*Decision from Jeffrey, 2026-08-25.* Active conversation replies need an
explicit, touch-safe **Cancel** control — not a tiny unlabeled close icon.
Cancelling a task-linked reply must use the durable agent-run cancellation
protocol, so a runner owned by another process receives the cancellation
request and terminates its CLI process tree instead of merely changing the
message's displayed status.
