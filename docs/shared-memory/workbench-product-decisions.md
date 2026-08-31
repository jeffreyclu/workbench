## Workbench product decisions

### Workbench tracks tokens, never cost

*Decision from Jeffrey, 2026-08-26.* Remove every cost metric, price table, estimate, provider-cost collector, API field, and UI surface from Workbench. Token counts are the only usage metric. Do not backfill, clear, or migrate historical database cost columns; released schema remains for compatibility, but application code must not read or write those fields.

### Open diffs stay stable; updates require an explicit refresh

*Decision from Jeffrey, 2026-08-25.* During an active task, Workbench may poll
for a newer local workspace revision, but it must not replace or re-render the
diff someone is reading. Keep the open diff as a stable snapshot. When a newer
revision is detected, show an orange **Refresh changes** button; only that
explicit action loads the new patch. This follows GitHub's review behavior and
keeps the live conversation/activity stream separate from the review surface.

### Changes tab is actionable only when a diff exists

*Decision from Jeffrey, 2026-08-25.* In a task-linked conversation, keep the
**Changes** tab visible but disable it until Workbench has confirmed at least
one local workspace or linked GitHub pull-request diff contains changed files.
Leave it disabled when both are empty or unavailable; it must not open an empty
review surface.

### Workspace diff history is an immutable review record

*Decision from Jeffrey, 2026-08-26.* Every distinct local workspace diff
opened in Workbench is persisted as an immutable task- or conversation-scoped
snapshot before it is rendered. The version browser lists those captured
patches even after a commit and push makes Git’s working tree clean. Reopening
the same revision must not create duplicate timeline entries; never overwrite
or delete a recorded patch as part of refresh, commit, or push.

If an agent commits before the uncommitted patch was captured, recover a record
only from a Git commit hash explicitly written in that conversation's persisted
messages. Verify the hash resolves to a commit, preserve its patch as an
immutable snapshot, and automatically open the latest non-empty record when
the current workspace is clean. Do not infer conversation ownership from
nearby commit times or branch order.

### Changes can commit and push the reviewed workspace

*Decision from Jeffrey, 2026-08-26.* The local-workspace Changes pane includes
one **Commit & push** control. It stages the reviewed workspace, commits using
the task title, then pushes the current branch to `origin`. Disable it while an
agent is running, with no local changes or commits to publish, from detached
HEAD, or without an `origin` remote. Show an explicit pending state and any
Git failure. If a commit succeeds but the push fails, the control becomes a
retry **Push N commits** action. A publish request must carry the displayed
diff revision; reject it when the workspace changed until the reviewer refreshes
the snapshot.

### Diff review uses one compact layout on desktop and phone

*Decision from Jeffrey, 2026-08-25.* Local workspace and GitHub pull-request
diffs use the same layout at every viewport: a compact horizontally scrollable
file rail above a full-width selected patch. Do not restore the desktop
side-by-side file sidebar; the patch is the primary review surface.

### Artifact comments live on the shared page

*Decision from Jeffrey, 2026-08-25.* Comments belong on the public artifact page
where a coworker reads the artifact, not in the authenticated Workbench library.
The library tracks and resolves received comments, but must not duplicate the
composer or present an internal Comment action. When `APP_API_ORIGIN` is public,
published pages use it as the feedback endpoint unless explicitly overridden.

*Correction from Jeffrey, 2026-08-25.* The public-page interaction is text-selection
anchored, not a page-level composer or table-only UI. Any text in a published
artifact can be selected to reveal the comment action; its thread opens in a side
rail. Store a deterministic page-local text range with each comment so the thread
remains associated with the reviewed text across reads of that immutable artifact
version.

### Browser chrome signals actionable conversation work

*Decision implemented 2026-08-25.*

When Workbench is backgrounded, browser chrome must surface conversations in
`needs_attention` or `waiting_approval`: title format is `(N) Workbench` and
the favicon has an attention dot. Do not use unread conversations for this
count; ordinary completed agent replies are not action-required. The precise
count refreshes through the authenticated shared WebSocket invalidation, with
a polling fallback. Desktop notifications remain unimplemented because they
require an explicit opt-in permission UX.

### Interject steers the active run; it must not create a parallel reply

*Decision corrected by Jeffrey, 2026-08-25.*

Interjecting a queued message must steer the already-running agent run in
place. It must not cancel the stream, defer to the next turn, or create a
second/parallel agent reply. Cancellation remains an explicit, separate
action. The prior implementation that allowed busy agents was rejected because
it visibly opened a parallel thread instead of steering the live one.

### The composer has one Send action; Queue is not a control

*Decision from Jeffrey, 2026-08-25, superseding the earlier Queue-control
decision.* Remove the composer **Queue** button. **Send** creates the normal
next-turn message. Interject remains an explicit action on an already queued
message.

### Parallel agent replies remain individually retryable

*Decision from Jeffrey, 2026-08-25; reconfirmed and superseding an earlier same-day instruction.*

When a conversation dispatches to both Codex and Claude, each failed or canceled agent reply keeps
its own **Retry / continue** control. Do not restrict retry to the chronologically latest agent
message: its sibling may have already failed and must not become unrecoverable merely because
another parallel reply exists.

Jeffrey initially asked for Cancel/Interject/Retry to be coupled into one atomic action across both
threads on a dual-agent dispatch ("cancel both together, retry both together"). He then retracted
this the same session: one stream can already be canceled or errored while the other is still
running, so **do not couple these actions** — Cancel, Interject, and Retry must each act on a single
agent reply independently. Any in-flight implementation work toward atomic paired-group semantics
for these controls should be dropped in favor of the existing per-reply behavior described above.

### Task attachments are part of pre-execution task context

*Decision from Jeffrey, 2026-08-25.*

Jeffrey must be able to attach one or more files to a task before execution.
Attachments are durable task context: show them while creating and editing a task,
store them with the task, and include their safe, local paths in every resulting
agent execution prompt. This is distinct from conversation-message attachments.

### Angriest day is the calendar day with the most curses, not a rolling window

On 2026-08-25, Jeffrey first asked for a rolling-24-hour reading, then corrected that on the same day: **Angriest day must show the calendar day with the highest curse count**, not a 24-hour rolling window and not a "last 24h" label. `summarizeCursing` computes `angriestDay: { day, count } | null` as the max entry of `byDay` (ties broken by earliest day); the Insights card renders it as `YYYY-MM-DD · count`. Do not reintroduce a rolling-window interpretation for this metric.

### Insights needs six time-frame options

*Decision from Jeffrey, 2026-08-28; corrected later that day.* Insights must offer exactly: **Last 15 minutes**, **Last hour**, **Last day**, **7 days**, **30 days**, and **All Time**. The new options extend, rather than replace, the existing 7-day and 30-day ranges. Keep all six choices when adding or revising Insights filters and calculations.

*Mobile correction from Jeffrey, 2026-08-29.* On phone layouts, expose those six Insights time frames through one dropdown instead of the expanded segmented-button panel. Desktop keeps the segmented control.

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

Corpus boundary clarification (2026-08-25): the hybrid index is materially
stronger for Workbench questions because it only ingests Workbench's durable
record (shared messages/conversations, activities, work items, agent-run
instructions/output/errors, audit entries, and this repository's `docs/`). It
does not index arbitrary external repositories, their files, or terminal
history. For non-Workbench work, useful results therefore depend on that work
having been recorded back into Workbench; this is an ingestion-coverage gap,
not evidence of a different retrieval algorithm or a Workbench-only ranking
path.

### Global search opens as an overlay and exposes result caps

*Decision from Jeffrey, 2026-08-25.* **Search everything** opens from its
search icon into a centered overlay, with the search field at the top and
results beneath it. Do not return to a sidebar-attached dropdown: it can be
clipped or sit behind the workspace. Hybrid-memory search must never silently
truncate its visible result cap; state how many results are shown and provide
an explicit way to load the next set when more ranked matches exist.

### Mobile conversation chrome collapses behind small toggle buttons

*Decision from Jeffrey, 2026-08-26, superseding both the original
disclosure-controls decision and the scroll-driven auto-collapse decision
that briefly replaced it.* Preserve the screen real estate win of collapsing
the header and composer on phone layouts, but drive it from two small
icon-only toggle buttons (tap to expand/collapse), not from thread scroll
direction. Scroll-driven auto-hide read as janky and unpredictable in
practice. Do not render full-width, text-labeled **Conversation details** or
**Compose/Show composer** buttons; they are unacceptable. The header and
composer default to collapsed on phone layouts to maximize thread space.

### Mobile composer action sits at the bottom-right

*Clarification from Jeffrey, 2026-08-27.* The floating composer button and
bottom-sheet grab handle are phone-only controls. Do not show either in a
narrow desktop window: phone conversation chrome requires both the compact
width and a coarse primary pointer.

*Correction from Jeffrey, 2026-08-27.* On phones, the **Open composer** action,
not the primary-nav Conversations icon, belongs in the bottom-right corner of
the page, above the bottom navigation and safe-area inset. Conversations stays
in the bottom tab bar. Keep the conversation-header control inline; the
composer control is the fixed bottom-right action.

The mobile conversation controls are hidden entirely at desktop widths.

*Clarification from Jeffrey, 2026-08-27.* The collapsed mobile conversation-tray opener is a wide, centered, opaque icon-only pill (76×44px), not a small square. It must be easy to tap while preserving the compact 32px controls inside the expanded tray.

### Mobile conversation action bar survives title collapse

*Correction from Jeffrey, 2026-08-27.* The floating phone conversation action
bar contains the conversation actions and remains available while compact. The
small header control only hides or shows the conversation title and metadata;
it must not hide the action bar. Leave the Conversation/Changes toggle alone
until it is separately decided.

### Phone changes review uses sequential decision navigation

*Decision from Jeffrey, 2026-08-28.* On phones, replace the horizontally
scrollable review-decision queue with a compact top navigator: previous and
next arrows move through decisions in their priority order. The decision detail
panel starts closed and opens only when the reviewer explicitly presses a
dedicated control. Desktop keeps the existing queue and immediately visible
detail card.

*Correction from Jeffrey, 2026-08-28.* The phone decision detail is a modal,
not an inline panel. It closes through its close control, Escape, or its
backdrop; keep the selected patch and sequential navigator visible behind it.

*Superseded by Jeffrey, 2026-08-29.* Changes review no longer needs a
phone-specific decision experience. Remove the sequential navigator and modal;
the relationship-prioritized desktop queue is the authoritative review flow.

### Relationship complexity determines review order

*Decision from Jeffrey, 2026-08-29.* Use the code diagram's relationships to
order review decisions. Pending code with more relationships is reviewed first;
defer code with no relationships to the end. For equally connected blocks,
show declarations before the implementations or call sites that depend on them,
then use source order as the deterministic tie-breaker. Settled decisions remain
after pending work.

### Code review is an automation-first attention stack

*Decision from Jeffrey, 2026-08-29.* Treat each logical code block as a discrete
review task in an attention stack. A Git diff hunk is only a transport boundary,
not a review unit: when one hunk adds or changes several logic blocks, split it
into separate tasks for the individual functions, branches, effects, handlers,
state transitions, or other coherent behaviors. Do not collapse dozens of lines
of new code into one decision merely because Git emitted one hunk.

Workbench should automatically review and settle the blocks that can be
established mechanically or with high confidence; the human should not spend
time repeating work the system can complete. Blocks that require experienced
judgment remain in the queue, ordered by how much attention they deserve.

The highest-priority blocks need the deepest assistance, not merely a higher
score: run the relevant review heuristics, provide grounded AI analysis, and
attach the existing AI-powered visualizations that help explain relationships,
behavior, and blast radius. Lower-priority blocks should receive cheaper,
shallower treatment or be automatically cleared when their obligations are
actually proven. The product succeeds when it reduces the amount Jeffrey must
review personally while concentrating his time and the most expensive analysis
on the code where human judgment matters most.

*Implementation boundary from Jeffrey, 2026-08-29.* Do not retrofit this
attention stack into the existing **Changes** view. Add it as a third,
independent conversation surface alongside **Conversation** and **Changes**.
The new review surface may use Changes as its base and import stable data,
diff-rendering, evidence, and visualization primitives where their contracts
fit, but Changes keeps its current behavior and review model. Semantic-block
state, automated settlements, priority routing, and tiered AI analysis belong
to the new surface and must not change what an existing Changes user sees.

*Visual reasoning correction from Jeffrey, 2026-08-29, revised after immediate
clarification.* The prioritized semantic-block queue remains the primary review
surface. The relationship visualizer is a critical helper reserved for the
most important paths, analogous to a surgeon using a camera where visibility is
needed rather than for every step. High-priority blocks receive the system-level
relationship view—callers, state, effects, tests, risks, and AI findings—alongside
their detailed code analysis. Low-priority or mechanically settled blocks do
not pay the rendering, analysis, or attention cost of a relationship map unless
they escalate. Queue selection controls which critical path the visualizer
shows; the map helps reason about that selected path but does not replace the
queue as the review workflow.

### Mobile composer closes as a bottom sheet

*Decision from Jeffrey, 2026-08-27.* When expanded on phones, the composer is
a bottom sheet with a centered grab handle. Tap the handle or swipe it down to
collapse; tapping the dimmed area outside the sheet also dismisses it. Do not
show a separate close icon while the sheet is open, because it overlaps the
composer controls. The bottom-right pen appears only while the composer is
closed.

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

### Agent debugger exposes actual decisions and tools

*Decision from Jeffrey, 2026-08-25.* The agent debugger is for the decisions an
agent makes and the tools it calls in each agent stream. Dispatch metadata
(model, profile, retry, fallback) is supporting context only; it does not
fulfill the debugger. Keep events scoped to the owning reply so simultaneous
Codex and Claude streams never show each other's calls.

*Presentation correction from Jeffrey, 2026-08-25.* The debugger must visibly
read as a tree, not a flattened table. Show the causal hierarchy as request →
agent stream → recorded decision → tool call, with connected branches and the
recorded decision visibly attached to the call it motivated. Keep raw call
detail inspectable through hover, keyboard focus, and click.

*Correction from Jeffrey, 2026-08-25, superseding the click interaction above.*
Every Request node must show the human-provided brief. Tool calls after a
decision must be visibly nested beneath that decision at its indentation level.
Raw details stay in the fixed details panel and are revealed by hover or
keyboard focus; do not render an Inspect control or make a call clickable.

### Session feedback retains decision-tree evidence

*Decision from Jeffrey, 2026-08-25.* After a task is completed, and after a
taskless conversation finishes or is archived, require a non-dismissible
**How did we do?** verdict with positive, neutral, and negative choices. Store
the selected outcome immutably with its associated conversation/task and the
decision-tree event snapshot visible at that time. This is training evidence
for identifying which agent decision trees work; do not make it a transient
toast or allow it to be silently skipped.

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

### Empty conversations expose execution type before the first reply

*Decision from Jeffrey, 2026-08-29.*

The robot execution-type control belongs in the header of a brand-new standalone
conversation, before any agent response exists. Its selected type must be sent
with the first message and used by dispatch; it is not only a label added after
the classifier has already launched an agent.

Task-linked conversations use the task-type robot instead. That control must
remain available in the mobile conversation header; mobile parity applies to
both standalone and task-linked conversations.

### Creating a conversation opens it immediately

*Decision from Jeffrey, 2026-08-25.*

After **New conversation** succeeds, open the new thread immediately, including
closing the mobile conversation rail so its composer is visible. Disable the
control while the create request is pending; one tap must never look like a
no-op or produce duplicate empty conversations.

### Completing or archiving a conversation returns to its stack

*Decision from Jeffrey, 2026-08-25.*

When a conversation is archived, or its linked task is completed (which
archives the conversation), clear the active conversation and show only the
conversation stack. Do not auto-open the first remaining conversation, even if
that first card is in **Pinned for you**. The next conversation opens only from
an explicit card selection or creating a new conversation.

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

*Decision from Jeffrey, 2026-08-27.* The mobile conversation header follows the Reddit-style
control hierarchy: put the linked-task return arrow on the left only when a linked task exists,
keep the close X at the top right, and center the conversation action controls in a floating pill.
Leave the Conversation/Changes toggle unchanged until it is separately decided.

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
  injected subset remains relevance- and token-budgeted from up to 100
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
both retrieve from up to 100 candidates and present only the relevance- and
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
turn is sent to both agents, fetch exactly one 100-candidate retrieval snapshot
before either reply starts, then give that snapshot to both. Independent
per-reply refreshes allow the first agent's streamed output to enter the
index while the second search is waiting, so it can displace the prior context
and leave the second recipient with only one memory. The injected result is
still selected by query-relative relevance and prompt budget, never a fixed
count. Regression coverage dispatches both fake agents and asserts one search
and identical four-memory details on both replies.

Retrieval candidate budget (2026-08-25): `searchMemory` considers up to 400
FTS chunks and 400 vector chunks before reciprocal-rank fusion and the
one-result-per-document deduplication. Long transcripts can otherwise fill a
100-chunk pool before deduplication, preventing broad recall across distinct
conversations, activities, and docs. The public result limit remains 100 and
prompt injection remains query-relative, non-duplicative, and constrained by
the prompt token budget; this change expands only the candidates considered.

Project-scoped retrieval (2026-08-25): a conversation linked to a task must
retrieve from every indexed message, activity, run, and task record attached
to that task's canonical project before rank selection. A corpus-wide ranking
lets unrelated long transcripts exhaust the relative-score threshold and leave
only one visible match. Unlinked conversations remain corpus-wide; project
filtering excludes only records attached to other projects, not the public
read-only search endpoint.

Current-turn echo exclusion (2026-08-25): shared-room retrieval must exclude
an indexed message whose body is exactly the current retrieval query before
relevance selection. Otherwise that just-created self-match can become the
strongest result and make the relative threshold discard the historical context
entirely. The read-only activity-memory endpoint retains the raw result so
diagnosis can still see it.

Conversation-local retrieval priority (2026-08-25): apply both safeguards.
Recent history from the active conversation is first-class prompt context with
its own bounded allocation; it must not compete on equal footing with the
global RAG corpus. Global RAG still uses the query-relative relevance cutoff
to reject noise, but retains a small absolute-rank floor so a narrow,
single-topic query cannot collapse to one result solely because RRF scores
fall below an arbitrary ratio. The combined policy is budget-bounded and
deduplicated; it is not a fixed total-result cap.

### Agent cancellation must be visible and authoritative

*Decision from Jeffrey, 2026-08-25.* Active conversation replies need an
explicit, touch-safe **Cancel** control — not a tiny unlabeled close icon.
Cancelling a task-linked reply must use the durable agent-run cancellation
protocol, so a runner owned by another process receives the cancellation
request and terminates its CLI process tree instead of merely changing the
message's displayed status.

### Interject steers the active provider turn; it never forks or cancels

*Decision from Jeffrey, 2026-08-25.* Interject is live input to every matching
active agent turn. It must preserve the existing stream and reply bubble, and
must never cancel it or launch a parallel reply.
Explicit Cancel remains the only termination action. The Codex app-server
protocol exposes this as `turn/steer`; a one-shot `codex exec` process cannot
implement the requirement.

*Implementation guardrail, 2026-08-25.* Send an interjection as an explicit
same-turn directive (acknowledge and apply it immediately), not a bare text
fragment. Provider acceptance of `turn/steer` alone is not evidence that the
active response visibly applied the direction.

*Startup behavior, 2026-08-25.* A click before the provider exposes its live
input channel is a durable, high-priority pending interjection, not a `409`
failure: deliver it automatically to that same turn when ready. Codex uses
app-server `turn/steer`; Claude uses its persistent `--input-format stream-json`
stdin channel. In both cases, return `202 pending` while startup is incomplete,
continue the existing stream, and never cancel or silently reroute it.

*UI acknowledgement, 2026-08-25.* An accepted interjection must remain visibly
marked on Jeffrey's message after it becomes completed. `queuePriority > 0` is
the durable record of an explicit interjection: render **Interjecting** while it
is still queued and **Interjected** only after the active provider accepted it.

*Presentation correction, 2026-08-25.* The acknowledgement must appear inside
the matching running agent's live activity stream, with Jeffrey's actual text
and a clear “You interjected” label. A standalone badge on Jeffrey's message is
not sufficient; it obscures where the live provider received the direction.

*Persistence correction, 2026-08-25.* The inline interjection is a durable
event at the activity-feed boundary where the provider accepted it. As later
activity arrives, it must retain that chronological position; switching away
from and back to the conversation must not append it at the live stream's
current bottom.

*Delivery guarantee, 2026-08-31.* Interjection is enforced by Workbench's
agent lifecycle, not left to a provider's willingness or a single transport
attempt. Codex retries `turn/steer` for as long as the targeted turn remains
active. Claude keeps its stream-json process open until every input Workbench
successfully wrote—including interjections—has produced a terminal result.
Any shared-conversation fallback to Codex must use the steerable app-server;
the one-shot `codex exec` transport is never a valid fallback for an active
conversation because it cannot receive live input.

### In-progress "thinking" activity is a log, not a finished report

*Fix from Claude, 2026-08-25.* The huge-circle-and-missing-space bug Jeffrey
flagged in a screenshot had two separate root causes, both in the live
progress path (`AgentMessageBody` with `running=true`), not the final reply:

- Missing space (e.g. "commandTypecheck is clean"): `agent-runner.ts` appends
  streamed `text_delta` chunks to `progress` verbatim with no separator. When
  a `content_block_start` for a new text block arrived right after a
  non-subagent tool-use progress line (e.g. `● Running a workspace command`),
  the first delta glued directly onto that line with zero characters between.
  Fixed by emitting a `blockBreak` signal on non-subagent `content_block_start`
  for `type: 'text'` and inserting `\n\n` before resuming delta appends.
- Huge circle: progress lines are logged server-side as literal `● Label`
  text, which `AgentMessageBody` fed straight through Markdown as plain
  paragraph text. The `●` glyph's em-box renders much taller than the 12px
  body copy, so it reads as an oversized circle. Fixed by converting
  `^●\s+` lines to real Markdown list items (`- `) only while `running`, so
  the browser sizes the bullet marker to match the text.

Decision: in-progress/thinking content is intentionally styled distinct from
a finished reply — dimmer color, monospace voice, dashed section border — via
a new `.agent-progress` class, so a live activity log never looks like the
polished final Brief/Detail report it will be replaced by.

### Fix: retrying one double-thread reply no longer blocks its sibling's retry

*Fix from Claude, 2026-08-25, per Jeffrey's decision above that Cancel/
Interject/Retry act on each agent reply independently.* Root cause of the
"Could not retry the response.×2 / This task already has an active agent
run." bug: `WorkbenchAdminService.retryRun`
(`src/server/services/workbench-admin-service.ts`) gated retry on
`repository.activeRunsForItem(workItemId).length`, i.e. any active run
anywhere on the task — including the sibling agent's own just-started retry.
On a task with two independent Codex+Claude threads, retrying both in
sequence made the second retry see the first retry's now-active run and
refuse. Fixed by scoping the guard to `run.agent === prior.agent`, so retry
only conflicts with an active run from the *same* agent. `startAgentRun` and
`startWorkItemExecution` keep the item-wide guard — those are fresh dispatch
paths, not per-reply retries, so deduping across the whole task is still
correct there. Regression test:
`src/server/app.test.ts` — "retrying one of two independent agent threads on
the same task does not block the other".

### Status: artifact comments — removed

*Decision from Jeffrey, 2026-08-25.* Artifact commenting is removed completely,
including the public-page layer and the Artifacts-page UI. Do not restore it
without an explicit new product decision.

*Operational cleanup, 2026-08-25.* Published artifact pages are immutable
Cloudflare Pages snapshots, so a runtime promotion does not update their HTML.
The two legacy `BpTiwkt10jUFhuWF` snapshots (`/` and `/v1/`) were cleaned and
the complete 94-page artifact tree was redeployed to
`workbench-artifacts-jeffrey`. Direct fetches verified neither live URL contains
the legacy comment markup. The superseded production deployment
`212646d2-9542-4480-a486-d05bc5f348de`, which still served that markup on its
deployment-specific hostname, was deleted and now returns 404. Future public
artifact UI removals need the same snapshot rebuild/redeploy plus stale
deployment cleanup.

Reply badge content expansion (2026-08-25): once the model/RAG badge row was
moved to its own line on both desktop and mobile (freeing horizontal room),
Jeffrey asked to add more info to the blue reply badge. `replyBadge`
(`src/client/features/conversation/view.tsx`) now also shows the execution
tier in parentheses after the model name when known (`economy`/`standard`/
`deep`; omitted for `routing`/null), prompt-cache token reuse as `"N cached"`
when `cacheReadInputTokens > 0`, and fallback provenance
(`fallback from <agent> (<reason>)`) when the reply is a fallback — all
previously hover-tooltip-only via `formatRunTelemetry`, now visible at a
glance. `compactTokenCount` was exported from `src/client/formatters.ts` to
back the cache-reuse figure. Verified: `tsc --noEmit` clean; full
`vitest run` 897/897 passing; production build clean.

### Pinned-task reminder re-fires every 30 minutes, not once/day

*Decision from Jeffrey, 2026-08-25.* The pinned-task toast in
`src/client/features/navigation/app.tsx` previously gated on a
`workbench:pinned-reminder-date` localStorage key, so it showed at most once
per calendar day regardless of session length. Changed to a rolling 30-minute
gate: the `pinned-reminder` query now sets `refetchInterval: 30 * 60_000`
(`PINNED_REMINDER_INTERVAL_MS`), and the effect stores a
`workbench:pinned-reminder-shown-at` timestamp, re-showing the toast whenever
`Date.now()` has advanced 30+ minutes past the last showing (count of pinned
items still gates it entirely — zero pinned means no toast). Verified:
`tsc --noEmit` clean; `vitest run src/client/App.test.tsx` 85/85 passing,
including the existing pinned-reminder-toast navigation test.

### Agent debugger only shows recorded rationale

*Decision from Jeffrey, 2026-08-25; clarified the same day.* The decision-tree
debugger must never invent a rationale. Show `Why:` only when the provider or
agent recorded a decision before that call; otherwise omit the line. Start new
Codex app-server turns with concise reasoning summaries, capture the completed
provider summary (including its `summary[]` form), and associate it with
subsequent tool calls. Claude does not expose hidden reasoning in stream-json:
record only its explicit, agent-authored `Decision:` preamble before a tool
call. Existing runs cannot be backfilled, but newly started agent streams show
the actual recorded decision and command sequence.

*UI cleanup from Jeffrey, 2026-08-25; revised the same day.* Render recorded
tool calls in a compact three-column table: `Decision | Why | Details`.
Decision and Why stay to one line and truncate rather than changing row height.
The Details trigger stays in the far-right column and reveals its raw recorded
call in one fixed Details panel, including on hover, keyboard focus, and click.
The table spans the modal's full content width; the Details panel sits below it
instead of reserving a desktop sidebar.
Decision records are association data, not standalone visible rows. Codex and
Claude use the same renderer and the same explicit-rationale-only rule.

### RAG memory index now also ingests the shared ~/notes knowledge base

*Fix from Jeffrey, 2026-08-25.* Root cause of "Workbench topics retrieve much
better than non-Workbench work": `collectMemoryDocuments`
(`src/server/memory-index.ts`) only ever ingested Workbench's own SQLite
tables plus one hardcoded doc root (`docs/` in this repo). Durable knowledge
recorded elsewhere — e.g. `~/notes/knowledge/*.md`, the tool-agnostic
knowledge base Claude and Codex both write Writer/engineering facts into per
`~/AGENTS.md` — was structurally invisible to search, no matter how good the
ranking was. Changed `collectMemoryDocuments` to accept a `docRoots` list
(defaults to `[workbench-docs: <cwd>/docs, notes: ~/notes]`), with each doc's
`source_id` now namespaced by root label (`<label>:<relative path>`) to avoid
collisions across roots. `docsRoot` (singular) is still accepted for
backwards compat with the one caller that only wants the repo's own docs.
Backfilled the live `data/workbench.db` by running `collectMemoryDocuments` +
`indexPendingMemory` directly via `tsx` against the running DB — no server
restart needed, since both `index.ts` startup and `repository.ts` search
already re-run these before every query. Result: 60 new documents / 423
chunks from `~/notes`, confirmed retrievable via
`/api/activity-memory` (e.g. a query about Connectors' org/user permission
model now surfaces `writer-connectors-permission-model.md`). This is still an
ingestion-coverage fix, not a ranking fix — anything recorded only in a
terminal session, another repo not scoped here, or a tool with no write-back
to Workbench or `~/notes` remains unindexed by design. Verified: `tsc
--noEmit` clean; `vitest run src/server/memory-index.test.ts` 15/15 passing;
backfill + live retrieval confirmed against the running server on :5180.

### Offsite backup pushes to GitHub silently stopped since 2026-08-23

*Diagnosed by Claude, 2026-08-25.* Jeffrey noticed the last edit in
`jeffreyclu/workbench-backups` was "2 days ago." Root cause: local SQLite
`data/workbench.db` grew from ~20MB to ~240MB between 2026-08-23 and
2026-08-25 (roughly 10x in 2 days, cause not yet investigated), pushing the
redacted `latest.db` snapshot past GitHub's 100MB per-file limit. The
`workbench-backups` repo has no Git LFS configured, so every `git push` since
2026-08-24T04:00 has been rejected by GitHub's pre-receive hook
("GH001: Large files detected"), and `scripts/backup.ts` throws uncaught on
push failure, logging the crash to `data/logs/backup-error.log`. Local
snapshotting in `data/backups/` (the `VACUUM INTO` step) is unaffected and
has continued on schedule — this is purely a failure of the offsite push
step, not the backup/retention mechanism itself. Confirmed via
`git clone` of the backups repo: last successful commit is
`2026-08-23T20:15:05-04:00` ("Snapshot 2026-08-24T00-15-05-081Z"). Needs a
fix (Git LFS on the backups repo, or compressing/chunking before push) and
separately the DB's rapid growth is worth investigating on its own.

**Fix shipped 2026-08-25 (Claude):** `scripts/backup.ts` now gzip-compresses
the redacted snapshot, then always splits it into 90MB chunks
(`latest.db.gz.part0000`, `part0001`, ...) via BSD `split -d -b 90m` before
pushing, and removes any stale chunks left over from a prior, larger backup.
This is unconditional (not just "when needed") so the offsite push stays
correct as the DB keeps growing, not just today's ~210MB size. Verified
end-to-end against a scratch local bare repo (`git init --bare`): push
succeeded, cloning back and running `cat part* | gzip -t` and reassembling
into a `.db` confirmed a valid, queryable SQLite file. Restore procedure
(`docs/backup-management.md`) updated to
`cat latest.db.gz.part* > latest.db.gz && gzip -dk latest.db.gz`.
### Finished Codex streams do not turn paragraph breaks into detail bubbles

*Decision from Jeffrey, 2026-08-25.* When a Codex stream completes, a long
blank-line-separated response (including the agent-debugger `Decision:`
updates) must remain in one response bubble, not a wall of one-line `Detail`
bubbles. Short unstructured replies may retain their existing restrained
multi-beat treatment; authored Markdown headings remain the explicit way to
request a titled report section.

*Clarification from Jeffrey, 2026-08-25.* Every completed Codex, Claude, and
system message in the shared room uses the detail-card treatment, even when it
contains only one response section. The one-card case is labeled `Detail`.
This does not reintroduce the stream regression: decision preambles stay out
of the completed body, and multi-block replies remain capped to a small number
of cards rather than one card per streamed line.
### Synthesized dual-agent replies do not trigger session feedback

*Decision from Jeffrey, 2026-08-25.* The automatic “How did we do?” prompt
must not open when a Codex-and-Claude turn finishes with a system synthesis.
That synthesis is system-generated completion, not an explicit request for
session feedback. Manual archive and task-completion feedback remain available.
### RAG memory retrieval: tiering plus a rank floor, both fixes together

*Decision from Jeffrey, 2026-08-25 ("hit it")* on the earlier synthesized
Codex+Claude proposal: implement both of two orthogonal fixes to
`selectRelevantMemoryForPrompt` in `src/server/agent-runner.ts`, not one
instead of the other.

1. **Tiering** — conversation-local (or work-item-local) history now gets its
   own additive budget (`PROMPT_MEMORY_LOCAL_BUDGET = 1_500` chars) with no
   relevance-score gate at all, filled before the existing global RAG budget
   (`PROMPT_MEMORY_BUDGET = 6_000`). A match is "local" if its
   `conversationId` or `workItemId` equals the caller-supplied `localId` —
   `item.id` for task runs (`agent-runner.ts`), `target.conversationId` for
   shared-room replies (`shared-room.ts`). This required surfacing
   `conversationId`/`workItemId` through `repository.ts#searchActivityMemory`,
   which had been dropping those fields even though `memory-index.ts` already
   returned them.
2. **Rank floor** — within the global RAG tier, the existing relative-score
   cutoff (`score < strongest * 0.5`, meant to reject noise on broad queries)
   now only applies past the top `RAG_RANK_FLOOR = 5` ranked candidates, so a
   narrow single-topic thread with no strong outlier score is no longer
   starved down to 1-2 results.

Both tiers dedupe against each other by normalized snippet key
(`snippetKeyOf`) so the same fact is never injected twice.

One bug caught during implementation, not by a test: `buildSharedReplyPrompt`
internally re-invokes `selectRelevantMemoryForPrompt` a second time via
`formatRetrievedMemory`. Without threading `localId` through that second call
too, local-tier items (admitted score-free on the first pass) would be
re-subjected to the score cutoff on the second pass and silently stripped,
defeating the tiering fix. Fixed by adding a `localId` parameter to both
`formatRetrievedMemory` and `buildSharedReplyPrompt`.

Verified: `npx tsc --noEmit -p .` clean; `npx vitest run` → 945/946 passing,
the one failure (`runtime-promotion-worker.test.ts`) reproduces identically on
`main` before this change (confirmed via `git stash`) and is unrelated.
Updated two pre-existing tests
(`agent-runner.test.ts`/`shared-room.test.ts`) whose assertions encoded the
old cutoff-only match counts (2 and 3 matches) — under the new rank floor
those same fixtures correctly resolve to 5 matches each.

Update 2026-08-25: the task-run formatting path now passes `item.id` into
`retrievedMemoryForPrompt()`, so its second selection preserves task-local
history's additive tier instead of silently filtering it back into the global
budget. `agent-runner.test.ts` covers a low-scoring task-local decision kept
alongside the global rank-floor matches.

## 2026-08-26: agent-runner reuse policy — hybrid, ship pool + conversation-scoped sessions first

Jeffrey approved (in shared room) the hybrid policy Claude/Codex proposed for
the per-request cold-start problem: reuse persistent/resumable sessions only
for coding conversations and active implementation tasks; keep research,
reviews, short room answers, and independent one-shot tasks ephemeral, as
today. Of the numbered options discussed, Jeffrey said to ship 1 and 2 first:

1. One process per active conversation/workspace (not per turn) for the
   coding-conversation path, instead of the current per-turn spawn.
2. A warm process pool per (agent, cwd) — pre-started idle runtimes handed a
   fresh task — to kill process-boot and MCP-negotiation cost. Complementary
   to (1), needed for the ephemeral path too.

Why this exists: `agent-runner.ts:510-541` spawns a cold process every turn —
Claude with `--no-session-persistence`, Codex as `exec --ephemeral` — by
deliberate design (comment at 522-538): unbounded reuse previously drove up to
13M cached tokens on a single ~10-minute run, and `--autocompact 100k` was
added as the mitigation. Any reuse work must keep that autocompact bound (or
an equivalent) on resumed/warm sessions so this doesn't regress into the
runaway-context failure mode the isolation design was built to avoid.

Tracked as Workbench work item "Agent runner: warm process pool +
per-conversation session reuse (coding only)" (created 2026-08-26).

Update 2026-08-25 build: Option 1 is implemented. `shared_conversations` gained
a `claude_session_id` column (migration `051_shared_conversation_claude_session_id`,
with an upgrade-path test from migration 050). `executeAgentRun` in
`agent-runner.ts` now resolves `resumeSessionId` from the conversation's stored
`claudeSessionId` only when `run.agent === 'claude' && run.kind === 'execute' &&
run.conversationId` — every other run kind/agent stays on the original
per-turn cold-spawn path. `commandFor` swaps `--no-session-persistence` for
`--resume <sessionId>` only when a resume id is present; `--autocompact 100k`
stays unconditional in both branches, preserving the runaway-context
mitigation. The session id returned by Claude's terminal `system`/`result`
stream-json events (`event.session_id`) is captured in `readableAgentEvent`
and persisted back via `repository.setConversationClaudeSessionId` after each
coding run, so the next turn on the same conversation resumes rather than
starting cold. Codex is untouched (`exec --ephemeral` unchanged).

Caveat: the exact shape of Claude Code CLI's stream-json `session_id` field
(which event(s) carry it) was not verified against live CLI output or docs —
implemented from prior general knowledge. Verify against a real run before
relying on it if resume appears to silently no-op.

Option 2 (warm process pool per agent+cwd) is now built and shipped — see the
2026-08-26 update below for final status.

### Code review lives in the conversation

*Decision from Jeffrey, 2026-08-26, superseding the PR-only scope.* The
conversation's linked task always exposes a named **Changes** review control.
Its primary content is the uncommitted, task-local workspace diff—the staged,
unstaged, and untracked changes an agent just wrote—so Jeffrey can review the
implementation without switching to Zed or another IDE. A linked GitHub PR is
an additional remote comparison shown in the same pane, not the condition for
local review.

This is a two-surface review flow. On desktop, **Conversation** is
reading-only; **Changes** owns the scrollable local/GitHub diff and the
composer as its fixed footer. Do not offer a split view. On phone, the same
Conversation/Changes switch stays available; the pencil appears only in
Changes and opens the composer sheet there. Keep the Changes header compact
so the diff remains the dominant surface. Fetch the local diff only when
Changes is opened; retain the GitHub diff's existing on-demand authenticated
path. Do not hide this workflow in task detail.

*Clarification from Jeffrey, 2026-08-28.* In a recorded **Workspace review
record**, the metadata immediately beneath the title—branch, capture status,
and run/commit provenance—is exactly one compact row. Do not confuse this
with agent-branch decision rows or hide it behind a disclosure. On a narrow
viewport it may wrap safely rather than overflow.

Update 2026-08-26: Option 2 design resolved (Jeffrey delegated: "you decide
what's best"). The pool serves ONLY the ephemeral/one-shot lane (research,
reviews, short room answers, independent parallel work) — coding-conversation
runs never draw from it, since they already get a specific `--resume
<sessionId>` from Option 1 that a generic warm process can't hold; mixing the
two lanes was the actual blocker. Pool key is `(agent, cwd)`. A claimed
process is used for exactly one task then torn down and replaced — no
cross-task context accumulation, since that's Option 1's job and doing it here
too would reopen the 13M-token regression. Health check is a liveness probe at
claim time only (no background scheduler for v1); idle TTL eviction (proposed
2 min) plus immediate reap on exit/failed probe, never retrying a dead
process. Pooled processes keep the unconditional `--autocompact 100k` — no
exception path.

Update 2026-08-26 (later same day): implementation confirmed shipped. Pool
manager (`agent-pool.ts`) implements claim/warm/evict with a liveness check
(`exitCode`/`signalCode`) at claim time, a 5-minute idle TTL swept both lazily
(on `warmProcess`) and by a 60s `setInterval` (`sweepIdlePool`/
`startPoolSweep`), and a 1-process-per-key idle cap. `agent-runner.ts` wires
`poolEligible` into `runAgentCommandWithFallback`, computed as
`!resumesSession` where `resumesSession = run.agent === 'claude' &&
run.kind === 'execute' && Boolean(run.conversationId)` — this is the explicit,
testable ephemeral-vs-persistent split the design called for. A follow-up
session found and fixed a gap: three ephemeral call sites in
`shared-room.ts` (initial room reply, Claude-scope recovery handoff to Codex,
`synthesizeSharedTurn`) were not passing `poolEligible = true`, so short room
answers and cross-agent synthesis weren't drawing from the pool despite being
named in-scope by this design. Fixed in commit `2a20715`.

Two accepted deviations from the original wording above, both deliberate and
left as-is rather than "corrected": idle TTL is 5 minutes, not the "proposed
2 min" — the shipped code's own doc comment treats 5 min as the considered
value. And reap is lazy/interval-swept rather than an immediate exit-listener
per process — functionally equivalent (a dead process is never handed out;
`isAlive()` is checked at claim time and sweeps happen every 60s or on next
warm), just not instantaneous-on-exit. Neither blocks the design intent.
Verified via `tsc --noEmit` (clean) and `npx vitest run` (987/988 passing; the
1 failure, `repository.test.ts` "shares one retrieval snapshot", is
pre-existing and unrelated — reproduced identically with the fix stashed
out). Tracked on work item `f762adb1`, description updated to reflect DONE on
both scope items.

### Claude continuation prompts are deltas, not replayed context

*Decision from Jeffrey, 2026-08-26.* Once an execute run has a persisted
Claude session ID, `--resume` already supplies the prior task and conversation
context. Its next user prompt must contain only the current task identity,
status, strategy, instructions, attachments, and the current external-action
contract. Do not re-inject shared context or retrieved memory on that turn;
the first run without a session ID still receives the complete prompt. Fixed
runner rules are passed through Claude CLI's `--append-system-prompt` channel,
not repeated in each user prompt. If a Claude run falls back to Codex, append
those rules back to the Codex user prompt because Codex has no equivalent
static channel here.
# Confidence assessments support direct follow-up context

*Decision from Jeffrey, 2026-08-26.* A confidence bubble in a code diff is an interactive details control, not just a score. Its details show the model's concise visible-code reasoning and a **Follow up** action. Follow up must carry the exact logical diff block, file location, confidence, and reasoning into the conversation draft so the next agent turn has the original code context. Use the existing message draft and canonical send path; do not invent a fake file upload or a separate backend persistence model for this context.

### The relationship map is a selective helper for critical paths

*Decision from Jeffrey, 2026-08-29. Supersedes the same-day claim that the
visualizer is the primary reasoning surface — that claim was wrong and Jeffrey
corrected it twice.* Queue-first is correct. The prioritized semantic-block
queue is the review workflow; the relationship map is a critical helper Jeffrey
opens on the most important paths only, the way a surgeon uses a camera for the
critical parts of a procedure rather than for every step. Do not restructure the
review surface so the map is the spine, and do not make the queue a derived
ordering of camera positions.

What survives from the earlier framing is only the map's internal modeling.
When a map is drawn for a critical block, node identity should be a place in the
system — a module or symbol that exists whether or not it changed — so unchanged
surroundings can be shown and the change reads as an overlay rather than as the
whole graph. Risk, priority, review state, and tokens spent are overlay layers on
that view. But the map is built on demand for escalated blocks; low-priority or
mechanically settled blocks never pay its analysis or rendering cost.
