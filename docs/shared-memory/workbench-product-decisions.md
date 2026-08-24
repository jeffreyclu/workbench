## Workbench product decisions

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
