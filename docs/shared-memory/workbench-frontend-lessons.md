## Workbench frontend lessons

### Promote UI/behavior fixes immediately instead of asking

When a fix changes what Jeffrey sees in the Workbench UI (a rail section, a filter, a rendered
state), promote it to the live runtime as part of finishing the task rather than leaving it staged
with an offer like "say the word if you want it pushed." Confirmed 2026-08-23: a fix was correctly
made and tested but left unpromoted; Jeffrey reported the exact same symptom again minutes later
because he was still looking at the stale live build, and only then was it promoted. Verifying a fix
against source and tests is not the same as verifying it against what Jeffrey actually sees — for
UI-visible changes, promotion is part of "done."

### A "regression test added" claim must be checked for what it actually asserts

2026-08-24: Codex reported the Active/Archive conversation-view toggle fixed, verified, and
promoted, backed by "a regression test for clicking Archive twice." Jeffrey reported it still
broken immediately after. Reading the added test (`App.test.tsx`, `'keeps the Archive view control
tappable after Archive is selected'`) showed it only asserted `aria-pressed` stayed `"true"` and the
button wasn't `disabled` after a second click — both true whether or not the click handler actually
re-ran. It never asserted the click produced an effect (a refetch, a state change). Writing an
independent test that clicked Archive → Active → Archive and counted `fetch` calls to the
`view=archive` endpoint proved the handler does fire correctly every time (count rose 2 → 4) — so
the toggle logic itself was not the bug. Separately, `/api/health` on the live gateway (port 5173)
was missing the `buildId` field present in the working-tree server source, showing the currently
promoted release predates the self-reload-toast feature, so a stale open tab would not self-heal
this time and a real hard refresh was still required. The lesson: when a subagent's "verified" claim
cites "added a regression test," read the test's actual assertions before trusting it — a test can
pass while asserting nothing about the behavior it claims to cover. Cross-check "still broken"
reports against the live served bundle (grep the promoted `client/assets/*.{js,css}` and compare
`/api/health`) before either re-diagnosing the code or telling Jeffrey to hard-refresh again.

For this control, the meaningful repeated-tap assertion is a second request to
`/api/shared/conversations?view=archive`, not focus, `aria-pressed`, or `disabled` state. An
already-selected view must have an explicit behavior: refresh its rail. It must also preserve the
currently selected archived conversation: clearing `conversationId` before checking whether the
view is already selected blanks the console and makes the repeat Archive tap look broken. Only
clear the selection when changing between Active and Archive; test the full flow of selecting an
archived conversation and then tapping Archive again.

The remaining live failure was pointer access, not the toggle handler. `SharedWorkspace` used
`endRef.scrollIntoView()` to follow new messages. That API scrolls every scrollable ancestor, so it
moved `.agent-console` (and, while its overflow containment was removed, `.shared-workspace`) upward
and physically put the menu and Active/Archive switch above the viewport. DOM `fireEvent.click`
tests cannot catch this because they ignore layout and hit-testing. Keep `.agent-console` overflow
contained and scroll `.shared-thread` directly with `scrollTo({ top: scrollHeight })`. Verify this
class of bug with a real browser pointer: `elementFromPoint` must resolve to the Archive button,
the repeated tap must send another `view=archive` request, both outer scroll positions must stay at
zero, and the selected archived conversation must remain open.

A later desktop-nav change added a fixed expanding sidebar at `z-index: 9` while leaving the
conversation view switch at `z-index: 2`. That made part of the Archive target lose hit-testing to
the nav during hover/collapse even though a center-point pointer test still passed. The observed
failure mode was navigation reopening the last Active conversation. Keep the view switch above the
primary-nav overlay, and test the stacking relationship itself; one successful click at the target's
center does not prove the whole touch target remains clickable through an animated overlay state.

### Task-linked conversation controls stay icon-only

*Decision from Jeffrey, 2026-08-23.* The task controls in a linked conversation header and the composer attachment control must not render text labels. Keep unlink, complete, and attach as compact, distinct icon buttons with accessible names and hover titles; regression tests must prevent visible button text from returning.


### Runtime promotion never reloads an already-open browser tab

`promote_runtime` rebuilds and swaps the backend process behind `:5173`, but nothing in the app
pushes a reload to a tab that was already open before the swap — the tab keeps running whatever JS
bundle it loaded at page-load time, indefinitely, until a hard refresh. Confirmed 2026-08-23: after a
verified promotion (server API correct, live bundle byte-matching the fixed source, 56/56 tests
green), Jeffrey still reported the fix as missing because his open tab predated the swap. Before
treating a UI fix as still broken post-promotion, verify server response + live bundle content first;
if those check out, the next step is "hard-refresh the tab," not "re-diagnose the code."

This recurred a fourth time on 2026-08-23 (the in-progress task-card badge), each time independently
re-verified as correct on the server/bundle before landing on "stale tab" again — a costly loop for
Jeffrey to sit through. Fixed at the root instead of re-explaining it again: `/api/health` now returns
a `buildId` (`randomUUID()` generated once per server process in `createApp`, `src/server/app.ts`),
and `App.tsx` polls it every 15s, showing a pinned "A newer version of Workbench is live" toast with a
Reload action the moment the id changes from what the tab first loaded. Promotions spawn a fresh
process per release, so this fires automatically on every future promotion with no other wiring. If
Jeffrey reports a verified fix as missing after this landed, do not assume stale tab again — that
path should now self-resolve via the toast, so treat it as a genuinely new bug and re-diagnose the
code first.

### Task-card status badges: bottom-right corner, styled as prominently as the convo view

*Decision from Jeffrey, 2026-08-23.* On task cards (`.queue-item` in `task-queue.tsx`), the status
badge (`finished`/`in_progress`/`follow_ups`/`needs_attention`/`promoting`/`waiting_promotion` via
`.agent-outcome`, and the archived completed/incomplete badge via `.archive-meta`) belongs in the
bottom-right corner of the card, not the top-right. Conversation cards are unaffected by this — the
convo view's badge styling (bold, boxed, high-contrast — see `.conversation-state-*` in
`styles.css`) is the reference standard for prominence that task badges should match, not a layout
Jeffrey wants copied onto conversations. Any future new task-card status badge should default to
this bottom-right, high-contrast boxed treatment (background + border + bold uppercase mono text)
rather than plain colored text — plain-text status labels (like the old `.archive-meta` incomplete
style) read as "impossible to read" against the dark card background.

When the card has state-specific effects, keep `.agent-outcome` as a direct overlay child of
`.queue-item`, not content inside `.item-copy`. The overlay must not reserve footer space, add
bottom padding, or otherwise affect the card's intrinsic height; it sits over the card's existing
bottom-right whitespace. The in-progress shimmer targets direct card children to establish
stacking. Its selector must explicitly preserve the badge's `position: absolute` and raise it
above the shimmer, or CSS cascade turns the badge back into a grid row.

### Virtualized-list row-height math must budget for the visual gap

`App.tsx`'s conversation rail is a manually virtualized list: rows are absolutely positioned via
`transform: translateY()` at an offset computed from `estimateSize()` (and, in the no-virtualizer
fallback, from an equivalent manual reduce over row heights). Neither computation reserved space for
inter-row spacing, so header-to-card and card-to-card gaps rendered as literal 0px even though the
CSS/JS elsewhere clearly intended visible separation (`e6bd0fa` added the "In progress" / "Pinned for
you" grouped headers without ever adding a gap term). Fixed 2026-08-23 by adding a
`CONVERSATION_ROW_GAP` constant folded into both the virtualizer's `estimateSize` and the fallback
offset reduce. The general lesson: any manually-virtualized (absolute-position + computed-offset)
list in this codebase needs its gap baked into the row-height math itself, not into CSS margin/padding
— CSS spacing on an absolutely positioned, intrinsically-sized row does nothing to push the next row
down, only a bigger reserved offset does.

## Stale responsive overrides survive UI convention changes — check media queries when a "fixed" style regresses

2026-08-23: after task-status badges were moved from top-right/inline to `position: absolute; bottom:
13px; right: 12px` on `.agent-outcome` (styles.css), two old responsive breakpoints (`max-width:
1200px` and `max-width: 820px`) still forced `.agent-outcome { position: static; ...margin-top: 2px
}` — a leftover from the pre-bottom-right layout where the badge needed to wrap onto its own line next
to a truncating title. Nobody removed it when the positioning convention changed, so on any moderately
narrow viewport (including a normal 3-panel desktop layout, not just phone widths) the badge fell out
of absolute positioning and back into grid flow, reproducing the exact "badge floats mid-card / wraps
to a new line" bug that had already been fixed at the base breakpoint. Lesson: when a Jeffrey-reported
visual regression matches a style that was verifiably already fixed, check `@media` blocks for a
duplicate/stale rule targeting the same selector before concluding it's a stale-tab/cache issue —
`grep -n '<selector>' styles.css` across the whole file, not just the base rule.

### Closing a task on mobile must not skip the stack route in browser history

`openPrimaryStack` (`src/client/App.tsx`) is the handler behind the "Attention stack" / "Workbench"
bottom-nav buttons. When a surface has a last-opened task (`readLastOpenedItem`), it used to jump
straight to `{ name: 'task', taskId }` via a single `navigate()` call, never pushing the `{ name:
'stack', stack }` route into history at all. On mobile, leaving a task is typically done via the OS
back gesture/button (`popstate`), not the in-app X — and with the stack route never pushed, that back
navigation skipped past the workbench/active list entirely and landed wherever history was before,
almost always the root attention stack (`/`). The first 2026-08-23 fix only pushed the stack route
first, then the task route on top of it. That fixed browser back history but did **not** fix X: both
`navigate()` calls run in one React event, so React can render only the final task route and never run
the effect that copies the intermediate stack route into `taskStack`. X then uses the previous
surface (for example Archive) as its close destination. The complete fix also sets `taskStack`
synchronously before the two navigations. General lesson for this router: an intermediate history
entry is not guaranteed to become rendered React state. Set any state needed by the final route
directly in the initiating handler. Any code path that
jumps directly into a `{ name: 'task' }` route without an intervening `{ name: 'stack' }` push breaks
back/close navigation on mobile, even if the desktop split-pane view looks unaffected — `navigate()`
calls in this codebase should mirror the visual navigation stack the user actually experiences, not
just the shortest path to the destination URL.
