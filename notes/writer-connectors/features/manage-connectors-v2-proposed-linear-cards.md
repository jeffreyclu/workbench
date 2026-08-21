# Manage Connectors V2 — proposed Linear cards

Status: draft for Jeffrey review. Not created in Linear.

**Sequencing note:** Build order is presentation-first. Cards 2, 3, and 4 run in parallel — the card and shell become visible on screen early, driven by fixtures. Card 1 (data extraction) runs sequentially as the foundation. Card 5 wires everything together. Card 6 is cutover.

**Two open scope calls before these go to Linear** (surfaced by technical grounding, not yet decided):

1. **Card 3's dialog has 5 downstream consumers.** `ConnectConnectorModal` (being replaced) is also used outside this page: the homepage onboarding widget, `event-triggers-selector.tsx`, the harness-v2 integration-setup card, and a thread tool-view connect-integration card. Card 3 itself stays fixtures-only and doesn't touch them — but card 5 needs to say whether those 5 call sites migrate to the new dialog or keep using the old one.
2. **Connector Gateway's revoke path skips config cleanup.** `use-cg-connectors.ts:169`'s `onProfileRevoked` unconditionally returns `true` — no cleanup happens before profile deletion. Only the legacy MCP path (`use-agent-connectors.ts:224-254`) actually gates deletion on cleanup success. Card 4's "revoke never deletes when cleanup fails" criterion currently only holds for the legacy path — decide whether card 4 also fixes the Connector Gateway stub or just preserves current (weaker) behavior there.

## 1. Extract data layer, normalize logos, and wire list state

**Description**

Create `use-connectors-tab-data.ts`, `use-connectors-list-state.ts`, and normalize logo resolution at the data boundary. This is the foundational sequential card: it fixes three production defects (pagination auto-drain, duplicate profile refetch, raw logo paths to `<img>`), consolidates the data contract for both gateway modes, and is the data source that card 5 swaps in for fixtures. Includes the V2 feature flag setup (30 min setup, not worth its own card).

The component being decomposed is `frontend/src/components/agents/manage-tabs/connectors-tab.tsx` (639 lines; companion test `connectors-tab.test.tsx` in the same folder — mirror it for the new hooks' tests). Neither `use-connectors-tab-data.ts` nor `use-connectors-list-state.ts` exists yet.

**Bugs being fixed, with exact locations:**

- **Pagination auto-drain** — `connectors-tab.tsx:250-256`: a `useEffect` calls `fetchNextPage()` on every render where `hasNextPage` is true, draining the entire paginated list on mount instead of loading page-by-page. Source hook: `useListUnifiedUserProfiles(organizationId, teamId)` in `frontend/src/hooks/react-query/mcp-gateway/use-gateway.ts:334-357`.
- **Duplicate profile refetch** — `connectors-tab.tsx:170-179` calls both `useAgentConnectors(...)` (`frontend/src/hooks/react-query/agent-config/use-agent-connectors.ts:66`) and `useCgConnectors(...)` unconditionally, then picks one via `useConnectorGateway ? cgConnectors : agentConnectors` (line 189) — the unused hook still runs its query. Fix by gating the unused hook with `enabled: false` or unifying the query key.
- **Raw logo paths to `<img>`** — `connectors-tab.tsx:546-548` falls back to the raw `config.connector.logo` value instead of routing through `resolveConnectorLogo` (`frontend/src/lib/utils/connectors.ts:16-32`, comment cites ACTION-6698). Fix: `resolveConnectorLogo(config.connector.logo, logoUrlMap)`. `logoUrlMap` comes from `useSignedLogoUrls(organizationId, allConfigs)` (`frontend/src/hooks/use-organization-signed-logo.ts:39-46`), query key `['signed-logos', orgId, sortedCustomPaths]`, `sortedCustomPaths` deduped/sorted via `isCustomLogoPath` (`connectors.ts:12-14`).

**Section classification note:** the current UI branches on a synthesized `enabled` flag, not real profile presence — `connector-gateway-adapter.ts:414` defaults `enabled: false`, then line 424 sets `enabled = profile.authenticated ? true : existing.enabled`. The new list-state hook should classify Connected/Available directly from the profile array, not this synthesized flag.

### Decision: profile states within the two-section UI

The page keeps exactly two presentation sections: **Connected** and **Available to connect**. They are not operational-state buckets.

- **Connected** means a profile exists for that connector. A card remains here when its profile is disabled, unhealthy, or needs reauthentication; moving it to Available would falsely imply that no connection exists.
- **Available to connect** means no applicable profile exists for the current context. Its Connect action enters the existing provider-specific connection route.
- A connector can have an organization profile, a user profile, or both. The projection must use the existing profile identity and ownership rules; it must not collapse them into one generic `enabled` boolean or silently choose one profile.

Each Connected card must expose a semantic status and only actions valid for its profile, ownership, permission, and auth route. The green connected indicator is reserved for a ready/healthy profile; it must not represent disabled or broken profiles as usable.

| Section | Existing profile condition | Card treatment | Primary action |
| --- | --- | --- | --- |
| Connected | Active and healthy | Connected status; ownership label where relevant | Manage |
| Connected | Disabled | Off status; preserve the existing profile | Turn on / Manage, if permitted |
| Connected | Authentication expired or connection error | Needs reconnect status and recovery copy | Reconnect |
| Connected | Organization-owned | Shared/organization ownership label; enforce organization permissions | Manage organization connection, if permitted |
| Connected | User-owned | Personal ownership label | Manage my connection |
| Available to connect | No applicable profile | No connection status | Connect |

`code_grant`, API-key, and HTTP-basic connectors stay on their existing auth routes. Auth type is not a third section or a generic visual badge by default; it changes the connect/reconnect flow and any copy needed to make that flow clear. Calendar is the proof case for a `code_grant` profile: an existing, expired Calendar profile remains in Connected and offers Reconnect, rather than appearing as a new Available connection. Add equivalent fixture/test coverage for API-key and HTTP-basic paths.

**Compatibility guardrail:** this page’s new projection must not change the Chat connector dropdown’s existing eligibility or profile-selection behavior. Before implementation, identify the dropdown’s ownership/profile-type assumptions; regression coverage must exercise the states above, including a Calendar `code_grant` profile.

**Flag:** existing gateway-mode flag is `useFeatureFlag('connector-gateway')` (`connectors-tab.tsx:131`, defined in `frontend/src/hooks/use-feature-flags.ts`). No V2 flag key exists yet in the flag hook — it needs to be created, following the same `useFeatureFlag('<key>')` pattern. Flag flips happen via the Statsig dashboard (see card 6), not a code change.

**Acceptance criteria**

- A dedicated V2 flag defaults off; the old page is unchanged when disabled.
- `ConnectorsTab` no longer reads provider queries, permissions, or `connector-gateway` directly — only props from hooks.
- Pagination fetches one page at a time; later pages load in context without auto-draining all pages on mount (fixes `connectors-tab.tsx:250-256`).
- The duplicate profile refetch (`connectors-tab.tsx:170-179`) is replaced by a single query with a stable, deduped cache key.
- Logo resolution uses `resolveConnectorLogo` at the data boundary: built-in URLs pass through, custom `logo_…` paths are signed via the `['signed-logos', orgId, sortedCustomPaths]` query, unsigned/in-flight/failed paths yield `undefined` (not raw storage paths).
- Connected and Available to connect are mutually exclusive projections based on actual profile presence, not the synthesized `enabled` field (`connector-gateway-adapter.ts:414,424`).
- The projection preserves profile ownership, health, and auth-route distinctions inside Connected; it does not reclassify disabled or expired profiles as Available.
- Search covers connector name, display name, profile name, and description across both sections.
- The delivered sort is name A–Z; no unapproved sort control is introduced.
- Tests cover both gateway modes, pagination, search, section classification, logo states (built-in, signed custom, unsigned custom, failure), and consent-replay scenarios.

## 2. Build connector card and page shell on fixtures

**Description**

Create a page-local `ConnectorManagementCard` and a props-only `connectors-page-shell.tsx` using WDS primitives and the existing `ConnectorIcon`. Build against a small fixture set (connected, available, default, various status/logo states) so the layout is visible on screen behind the V2 flag before any real data wiring. The shell is pure presentation — zero hooks, provider queries, mutations, auth, or persistence APIs, only props.

**Fork source:** `frontend/src/components/projects/project-settings-connectors/project-settings-connectors.tsx:358-457` (`AddedConnectorCard`/`AvailableConnectorCard`) — props-only `<article>` cards using WDS `Button`/`DropdownMenu` and `ConnectorIcon`. Not `connector-card.tsx`'s `ConnectorCard` (explicitly library-only, wrong shape) and not a WDS `SelectorCard` (doesn't exist in this codebase's WDS surface).

**The 4 deltas vs. the fork source, confirmed by reading it:**

1. `AddedConnectorCard` renders `<Check/> Added` text (line 384-387) → swap for `ConnectorStatusIndicator` (`frontend/src/components/connectors/connector-status-indicator.tsx`), which already implements the green pulsing dot for CONNECTED/AUTHENTICATED.
2. No default pill exists on this card today → reuse `DefaultBadge` (`frontend/src/components/connectors/default-badge.tsx`, wraps WDS `Badge` variant="primary").
3. `AvailableConnectorCard` button label is `"Add"` (line 453) → rename to `"Connect"`.
4. Both cards render in a `space-y-1.5` vertical list (line 344-356) → replace with responsive `grid-cols-*` for the 4/2/2/1 layout. Exact breakpoint px values (2400/1400/1031/768/640) weren't verified against `tailwind.config`/WDS tokens — confirm before hardcoding.

**Reusable primitives already built — cite these, don't rebuild:**

- `ConnectorIcon` (`frontend/src/components/connectors/connector-icon.tsx:38-71`) — already handles the broken/missing-logo fallback via `Plug` from `lucide-react`.
- `ConnectorStatusIndicator`, `DefaultBadge` — as above.
- Overflow menu: mirror `DropdownMenu*` usage at `project-settings-connectors.tsx:389-411`.

**Storybook precedent:** `project-settings-connectors.stories.tsx:1-60` — `Meta`/`StoryObj`, `fn()` mocks, hand-built fixture arrays plus a `createProfile()` factory for bulk fixtures (used for a 15-item pagination story). Good template for this card's fixture set. No `.stories.tsx` precedent exists yet in `agents/manage-tabs/` specifically — this file is one directory over and is the nearest real analog.

**Acceptance criteria**

- The shell imports only props and local fixture data — no feature flags, provider queries, auth hooks, or persistence APIs.
- Cards display a status treatment appropriate to the actual profile state, Default pill (`DefaultBadge`) where applicable, Connect action, overflow menu, accessible status text, ownership label where relevant, and resolved-logo/fallback rendering via `ConnectorIcon` (fixtures include a broken/unsigned logo case). Green `ConnectorStatusIndicator` is only used for ready/healthy profiles.
- Grid renders four, two, two, and one columns at 2400, 1400, 1031/768, and 640px design widths without horizontal overflow — verify exact breakpoints against `tailwind.config`/WDS tokens before implementing.
- Search, sort, and the Available action are keyboard accessible; Available action scrolls and focuses its section with reduced-motion-safe behavior.
- Initial load, per-section empty states, no-search-result, later-page loading, and retryable-error states are visually distinct and triggerable from the fixture set.
- Light/dark, hover, menu-open, healthy connected, disabled, needs-reconnect, organization-owned, user-owned, available, and default variants have component coverage, matching the `project-settings-connectors.stories.tsx` fixture-array pattern. Fixtures cover Calendar `code_grant`, API-key, and HTTP-basic routes.

## 3. Build the designed Connect dialog on fixtures

**Description**

Build the connecting, success, and failure states for the Connect dialog from the Figma spec. All three states are driven by fixture props (no real OAuth polling or API-key submission) so the UX and copy are reviewable on screen. Wiring to the real connection flow happens in card 5.

**Files being replaced** (both under `agents/manage-tabs/`, not `connectors/`):

- `frontend/src/components/agents/manage-tabs/connect-connector-modal.tsx` (OAuth; test file exists)
- `frontend/src/components/agents/manage-tabs/connect-api-key-modal.tsx` (API-key; no existing test file)

**Current state shapes to mirror, not redesign:** OAuth modal tracks separate booleans (`isAuthorizing`, `isAuthorized`, `error`, `timeoutReached`, `hasManualWindowOpened`, line 64-68), polls every 5s (`POLLING_INTERVAL`, line 46), 120s hardcoded timeout (line 45), and already uses `aria-live="polite"` for status announcements (line 314) — reuse that pattern. API-key modal has no distinct "connecting" visual today, just a pending button state and inline error text, and closes silently on success with no success screen — **giving it a real success state is new UX scope, not parity**, flag this explicitly rather than treating it as a mirror.

**Focus trap / Escape / restoration:** no custom wrapper exists — WDS `Dialog`/`DialogContent` is a thin layer over `@radix-ui/react-dialog`, which handles all three natively. The acceptance criterion is effectively "keep composing WDS `Dialog` primitives, don't suppress `onOpenChange`/Escape during fixture-state transitions."

**Blast radius — out of scope for this card but plan around it:** `ConnectConnectorModal` is imported in 5 places beyond `connectors-tab.tsx`: `homepage-widgets/widgets/onboarding/components/onboarding-connect-tools-section.tsx`, `common/event-triggers-selector.tsx`, `harness-v2/features/writer-integration-setup/card.tsx`, `thread/tool-views/connect-integration/connect-integration-card.tsx`. This card only builds the new component on fixtures; card 5 needs to decide whether those 5 sites migrate too (see open scope call at top of doc).

**Acceptance criteria**

- OAuth and API-key paths display accessible connecting, success, and failure states from fixture input.
- Failure state shows useful reason text and recovery action (mirroring the existing "Open sign-in page" retry at `connect-connector-modal.tsx:359-363`); success and automatic-close are announced accessibly (`aria-live="polite"`, matching line 314).
- Focus traps, Escape behavior, close controls, and focus restoration work in each state, via WDS `Dialog`/`DialogContent`/Radix — no custom implementation needed.
- Component tests cover success, failure, cancellation, and retry using fixtures, independent of any backend, following the mocked-hooks/timers pattern in `connect-connector-modal.test.tsx`.
- Card explicitly does not touch the 5 existing `ConnectConnectorModal` call sites outside this page.

## 4. Wire modal and action orchestration

**Description**

Create `use-connectors-modal-orchestration.ts` to own selected connector state, consent deferral, auth routing, profile actions, and modal transitions. Explore and Preview remain as existing leaf components; this card only moves their trigger wiring. Introduce page-scoped Jotai state for dialog/pending interaction state if needed, as a scoped exception to zustand.

**State to move**, from `connectors-tab.tsx:116-128`: `isAddConnectorModalOpen`, `selectedConnectorId`, `isPreviewModalOpen`, `isConnectApiKeyModalOpen`, `pendingAllowAction`, `sortField`/`sortOrder`, `openRowMenuProfileId`, `connectingOrganizationProfileIds`. Handlers: `handleConnectorClick`, `handleConnectClick`, `handleConnectorEnabledChange`, `startConnection`, `handleAuthenticated`, `handleRevokeAccessClick`, `handlePreviewModalOpenChange`, `handleAllowConnectorsAccept/Cancel`, `handleProfileAction`.

**Consent gating already exists — preserve it, don't redesign it.** `hasConnectorsConsent()` (`allow-connectors-modal.tsx:22`, backed by `ALLOW_CONNECTORS_STORAGE_KEY`). A blocked action is captured as `pendingAllowAction: { action: 'connect'|'enable', source: 'table'|'preview' }` and replayed exactly once in `handleAllowConnectorsAccept` (line 407-428), then unconditionally cleared. `handleAllowConnectorsCancel` (430-436) clears without replay. The acceptance criterion here is "preserve," not "design."

**Explore/Preview interfaces (confirms trigger-wiring-only scope):** `ExploreConnectorsModal` takes `open`, `appConfigs`, `connectorConfigs`, `onOpenChange`, `handleConnectorCardClick`, `availableCategories`. `PreviewConnectorModal` takes `open`, `onOpenChange`, `userAgentConfig`, `connectorConfig`, `onConnect`, `onConnectorToolToggle`, `onConnectorEnabledChange`, `isToolConnected`, `isExploreOpen`, `isDefault`.

**OAuth/CG routing:** `useConnectorAuth({organizationId, teamId, onAuthenticationSuccess})` returns `startAuthorization` and `connectConnectorModalProps` (`frontend/src/hooks/use-connector-auth.ts:30,82,214`). `startConnection` (`connectors-tab.tsx:330-365`) branches: CG org-profile → `useConnectOrganizationProfile.mutateAsync`; CG API-key needed → opens `ConnectApiKeyModal`; else → `startAuthorization`.

**Revoke — the real gap.** Legacy path (`use-agent-connectors.ts:224-254`) patches connector status to `REVOKED` first and only returns `true` (permitting delete) if that succeeds — `handleRevokeAccessClick` (`connectors-tab.tsx:381-398`) only calls `useDeleteProfile().mutate(...)` when it gets `true` back. **Connector Gateway's equivalent (`use-cg-connectors.ts:169-171`) is a stub that unconditionally `return true`** — no cleanup happens on that path today. See the open scope call at the top of this doc.

**Jotai:** zero existing usage anywhere in `frontend/src` — this would be the first instance in the codebase (existing state management is zustand, e.g. `frontend/src/stores/*.ts`). Treat as a precedent-setting decision worth a second look, not a minor implementation detail.

**Acceptance criteria**

- `ConnectorsTab` no longer owns scattered modal, selection, or row-menu state.
- Explore and Preview remain functional; they are not consolidated or deleted.
- The existing consent-replay behavior (`pendingAllowAction` → `handleAllowConnectorsAccept`) is preserved: a connect/enable action blocked by consent resumes exactly once after consent is accepted, not after cancellation.
- OAuth, API-key, organization-profile, default, disconnect, revoke, and legacy-vs-gateway post-auth paths preserve current behavior.
- A disabled or expired existing profile is managed/recovered in place under Connected; it is never routed through the new-profile Available flow merely because it is not currently usable.
- Revoke never deletes a profile when prerequisite config cleanup fails, for the legacy path (already true today). **Decide explicitly whether this card also fixes the Connector Gateway stub (`use-cg-connectors.ts:169`) or documents it as known-preserved-but-weaker.**
- Tests cover consent replay, connection routing, organization-connect deduplication, and revoke failure (both gateway modes if the CG gap is being fixed here).
- Jotai's introduction is called out explicitly in the PR description as a first-of-its-kind scoped exception to zustand, not folded silently into the diff.

## 5. Wire shell and dialogs to real data

**Description**

Swap fixtures in cards 2 and 3 for real data and orchestration from card 1 and card 4. The shell now renders live connector state; the Connect dialog now drives real OAuth polling and API-key submission. Verify all four combinations of V2/gateway flags and both gateway modes produce identical outputs.

**Flag branch to mirror:** `connectors-tab.tsx:131-189` calls both `useAgentConnectors` and `useCgConnectors` unconditionally (rules-of-hooks), then switches the result object on `useFeatureFlag('connector-gateway')`. The new hooks (`use-connectors-tab-data`, `use-connectors-list-state`, `use-connectors-modal-orchestration`) need to internally reproduce this same "call both, pick one" pattern — the shell and dialog stay agnostic and just consume whatever the hooks return.

**No existing page-swap precedent.** Searched the codebase for an established "old component vs. new component behind a flag" pattern — none exists. The closest analog, `useIsCustomizePageAvailable`, drives route/redirect decisions, not an in-place component swap. Don't imply this project is following an established convention; it's setting one.

**Matrix test pattern to use:** typed case arrays driven by `it.each` (not `describe.each`) — precedent in `connector-gateway-adapter.test.ts:43-388` and `use-gateway.test.ts:85-114`. Define a typed case array covering V2 flag × gateway flag × scenario.

**Hard dependency, not just sequencing:** `use-connectors-tab-data.ts`, `use-connectors-list-state.ts`, and `use-connectors-modal-orchestration.ts` don't exist yet — confirmed by search. This card cannot start until cards 1 and 4 land, not just "should go after" them.

**Acceptance criteria**

- Card-2 shell now reads `use-connectors-tab-data` and `use-connectors-list-state` instead of fixtures — props contract unchanged.
- Card-3 Connect dialog now reads `use-connectors-modal-orchestration` instead of fixtures — props contract unchanged.
- V2 off: old page renders unchanged. V2 on: new page functions with all real data.
- Both gateway modes (legacy MCP and Connector Gateway) render the same sections, counts, logos, and status.
- Both gateway modes preserve the two-section state model: disabled, expired, organization-owned, and user-owned existing profiles remain Connected with the correct permitted action and auth route.
- Connection, consent, API-key, default, disconnect, revoke, loading, partial-failure/retry, and logo-failure flows work in both gateway modes where applicable.
- Explicit decision recorded on whether the 5 external `ConnectConnectorModal` call sites (card 3) migrate to the new dialog as part of this card.
- Matrix tests use a typed case array + `it.each`, matching `connector-gateway-adapter.test.ts`.

## 6. Verification, flag cutover, and cleanup

**Description**

Validate the fully-wired V2 page against both provider modes and supported viewports, then flip the flag default-on and delete the old table page.

**Flag flip is an ops action, not a PR.** Flags are read via `useFeatureFlag(flagKey)` and flipped through the Statsig dashboard (target org/team) — there's no code or config file to change. Call this out as a separate ops step in the rollout plan, not a commit. `.claude/skills/deprecate-feature-flags/SKILL.md` exists in-repo for the eventual flag-removal cleanup.

**Code to delete once V2 is default-on**, all inside `connectors-tab.tsx` today (no separate V2 file exists yet — it gets built by cards 1-5):

- `connectors-tab.tsx:506-578` — the `Table`/`TableHeader`/`TableRow`/`TableBody`/`Pagination` block and `ConnectorTableHead` helper (line 633-637)
- `connector-table-row.tsx` — row renderer
- `connectors-tab-sort-indicator.tsx` — sort arrows
- `frontend/src/hooks/use-paginated-search.ts` — client-side pager/offset logic (`CONNECTORS_PER_PAGE = 25`)

Note: pagination here is presentational only — every row is already fetched via infinite query before slicing, so deleting the pager doesn't touch any data-fetching code.

**No automated visual regression tooling** (no Chromatic/Percy) — Storybook exists and deploys per-PR via GitHub Pages, but "visual comparison" means manual screenshot diffing against Storybook/Figma, not an automated CI gate.

**Correct npm/pnpm scripts** (the draft's names were wrong): typecheck is `pnpm type-check` (not `typecheck`); unit tests are `pnpm test:unit` (`pnpm test` is Playwright E2E — decide if E2E coverage is also required here); build is `pnpm build`.

**Acceptance criteria**

- Both V2 off and V2 on states are fully functional until cutover.
- Verification covers all four V2/gateway flag combinations, desktop and narrow viewports, light/dark themes, keyboard navigation, and screen-reader-visible status/error copy.
- Regression coverage verifies that the Chat connector dropdown retains its existing eligibility and profile-selection behavior for organization, user, disabled, and expired profiles, including a Calendar `code_grant` case.
- Visual comparison (manual, against Storybook/Figma — no automated tooling exists) documents intended design differences and shows no unintended regression.
- The old table/page-number UI (`connectors-tab.tsx:506-578`, `connector-table-row.tsx`, `connectors-tab-sort-indicator.tsx`, `use-paginated-search.ts`) is deleted only after V2 is default-on via the Statsig dashboard.
- `pnpm type-check`, `pnpm test:unit`, and `pnpm build` pass.

## Separate product decision — first-use setup dialog

The Figma onboarding/empty-state dialog is not included above. Product needs to define when it appears, what its checkbox controls, and where that preference persists before it becomes an implementation card.

## Separate bug — org/user tool-gating inversion (not a V2 card)

`connector-gateway-adapter.ts` reads an org profile's empty tool allow-list as "everything enabled," but the backend reads an empty list as "nothing allowed." An org profile with no explicit tool allow-list would show the UI saying every function is enabled while every actual call fails. Confirmed by reading the source; not yet verified at runtime.

This doesn't land on any of the 6 cards above — the per-tool toggle UI (`isToolConnected`, `onConnectorToolToggle`) lives in `PreviewConnectorModal`, which card 4 explicitly keeps as an untouched existing leaf component. File as its own ticket, not folded into this redesign.
