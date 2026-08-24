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

### Archive cards show dates, not a second completion-status badge

*Decision from Jeffrey, 2026-08-24.* Archive is a filter on the task stack. An archived card may
retain its archive date as muted inline metadata (`Archived <date>`), but it must not render a second
`Completed` or `Incomplete` badge beside the task's agent-outcome badge (`Finished`, etc.). The task
outcome is the single visible status badge; preserve dates without treating them as another status.

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

### A stale rendered route must never remount `SharedWorkspace`

Jeffrey reported the same Archive bug five separate times across four "verified and promoted" agent
fixes (2026-08-24). Every one of those fixes addressed a real but secondary issue — z-index
occlusion, autoscroll moving the header, clearing the selection on a repeat tap — and none addressed
the actual cause, because each was validated with a **single** Active → Archive transition. The bug
only appears on the third switch, once both rails have rendered at least once and both TanStack Query
caches are warm.

The cause: `App` remounts `SharedWorkspace` via `key={`conversation-${conversationNavigationVersion}`}`
whenever the address names a conversation the workspace did not itself select, and that remount reset
the rail's `conversationView` to `'active'`. Switching rails clears the selection first, so the
address transiently becomes `/conversations` before the new rail auto-selects its first row and pushes
`/conversations/<id>`. Because the workspace's own effects flush *before* the parent's, the parent's
guard effect could run on a render whose `route` already described a superseded address while
`syncedConversationId.current` had advanced past it — `null !== <archived id>` — firing a spurious
remount. The visible result was exactly Jeffrey's words: the Archive tab snapped back to Active while
an unrelated archived conversation opened underneath it.

Two rules follow, both now enforced in the code:

- A guard that decides whether navigation came from *outside* a component must compare against the
  live `window.location.pathname`, not only the route object from the current render. In an app where
  a child effect calls `history.pushState`, the parent's rendered route is routinely one step behind
  reality, and treating that lag as an external navigation causes spurious remounts.
- State a remount would silently discard must live above the remount key. `conversationView` is now
  owned by `App` and passed down as an optional controlled `view`/`onViewChange` pair; the workspace
  keeps its own state only when rendered standalone, so existing standalone tests still exercise the
  tabs.

Method lesson, which generalizes past this bug: when Jeffrey says a UI fix is still broken after tests
pass, drive the real app in a real browser at his viewport before touching the code. `playwright` and
both `chromium` and `webkit` browsers are already installed in this repo; a throwaway script against a
`vite` dev server pointed at the live API (`WORKBENCH_API_TARGET=http://127.0.0.1:5173`) reproduces
against real data in under a minute. Reproduce the *multi-step* sequence — repeat each toggle three
times — because state that only corrupts after both branches have been visited is invisible to a
one-transition test. Run that server as a child process of a single foreground script that kills it in
a `finally`, and put the readiness wait inside the `try`, or a startup failure leaks the process.

The control also remained only 32px high on a phone after earlier reports called it “tappable.” Keep
Active and Archive at least 44px high. The permanent regression runs the complete pointer flow in both
Chromium mobile emulation and WebKit, proves the second tap sends `view=archive`, retains the archived
URL and heading, and probes every part of the target while the desktop nav is expanded.

### Expanded desktop navigation must not overlay workspace controls

*Correction from Jeffrey, 2026-08-24.* Raising the Active/Archive switch above a fixed, expanding
desktop sidebar preserved pointer access but made the switch visibly float across the navigation rail.
That is not an acceptable interaction. When the desktop rail expands, give it its own grid column so
the workspace starts after it; do not solve an overlap by raising the covered control's z-index.

### "A bubble cannot exceed the width of the screen" means its rendered content, not its box

Jeffrey has now had to repeat this constraint twice, and the first fix failed because it was read too
narrowly. Capping `.shared-message` with `width: min(94%, 640px); min-width: 0; max-width: 100%` bounds
the *box* and satisfies a CSS-source unit test, while the content inside it still paints hundreds of
pixels past the phone screen. On a 390px viewport a structured agent reply measured `clientWidth: 338`
with `scrollWidth: 3106`, and its `.agent-response-section` painted out to x=3121. The rule Jeffrey is
stating covers everything the user can see, so the assertion has to be a real layout measurement of
every descendant, not a string match on the stylesheet.

Two structural causes, both specific to agent bubbles rather than Jeffrey's own messages:

- `.agent-response` and `.agent-response-deck` are grid containers whose items default to
  `min-width: auto`, so a single unbreakable URL or token inside a section sizes the track to
  max-content and drags the whole bubble open. Give every grid container and item in that chain
  `min-width: 0` (plus `grid-template-columns: minmax(0, 1fr)`), and give code blocks and tables
  `max-width: 100%` so they scroll inside the bubble instead of widening it.
- `.live-run-output pre` had no CSS rule at all. A bare `<pre>` is `white-space: pre` with no overflow,
  so a streaming tool log stretched the bubble to the width of its longest line — which is why the
  problem looked worst while an agent was mid-run.

`.shared-message` now also carries `overflow: hidden` as a standing clip boundary, so any future
descendant that escapes is contained rather than shipped.

Testing note: agent-authored and `running` messages cannot be created over the public API in e2e
(`e2eRuntimeCapabilities.executeAgents` is `false`), and they are exactly the bubbles that break. The
Playwright harness in `scripts/e2e-api.ts` therefore mounts a test-only `POST /api/e2e/seed-message`
route ahead of the real app, in the script and never in shipped server code. When asserting overflow,
exempt descendants that sit inside their own horizontal scroll container — a code block scrolling
within the bubble is the intended treatment, and flagging it hides the real offenders.
