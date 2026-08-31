# Manage Connectors action catalog

## Audit scope

- Audited local `writer-monorepo` branch `main` at commit `e7f9c9f6e0ff9ac9ecf6baf8408e3900211cb27f` (`2026-08-26T19:55:38Z`).
- Static source analysis only. No application, API, or test was run.
- The dirty `feat/con-connectors-v2-projection` worktree was explicitly excluded.
- `main` has one table-based Manage Connectors UI. `actionagentmanageconnectorsv2` does not select a V2 UI on this commit; it only decides whether concurrent Connector Gateway page requests share the same cached `profiles/my` request.
- Primary frontend entry: `frontend/src/components/agents/manage-tabs/connectors-tab.tsx`.

## Architecture boundary

The same frontend supports two transports selected by `connector-gateway`:

- **Connector Gateway on:** profile state, tool selection, defaults, connect, disconnect, and revoke go to `/api/connector-gateway/v1/**`.
- **Connector Gateway off:** connect/disconnect, tool selection, default selection, and the agent-config cleanup before revoke update Writer's user-agent config with `PUT /api/organization/{orgId}/team/{teamId}/agents/{agentId}/config`. OAuth and profile deletion use `/api/mcp-gateway/v2/**`.

The monorepo implements the user-agent-config backend. The Connector Gateway and MCP Gateway routes used by this tab are generated client contracts whose server implementation is outside `writer-monorepo`. The monorepo endpoint `POST /api/organization/{orgId}/team/{teamId}/connectors/oauth/initiate` is not called by this tab on this commit.

## Connection-state matrix

Every profile row resolves to one of five states. This state determines the visible connect action.

| State | Derivation | Main action |
|---|---|---|
| `connected` | Authenticated and connected | Show Connected; overflow and preview offer Disconnect |
| `authenticated_not_runnable` | Authenticated but not connected | Connect by enabling/reconnecting; do not start OAuth |
| `disconnected` | User OAuth credential retained after disconnect | Connect by reviving the profile; do not require a fresh OAuth round trip |
| `login_required` | User OAuth without an authenticated/retained profile | Start OAuth |
| `not_available` | Everything else | Connect; CG user API-key profiles open API-key entry, org profiles connect directly, other user profiles start authorization |

`Revoke access` is independently available only for user-level OAuth with either an authenticated credential or a retained disconnected credential.

## Reachable frontend actions

### Main table

| ID | User action | Availability and result | Backend effect | Existing direct coverage |
|---|---|---|---|---|
| M01 | Search connectors | Debounced client filter over canonical connector name, display name, profile name, and description. Resets client pagination through `usePaginatedSearch`. | None after initial data load. | None found |
| M02 | Sort by Connector | Click header to sort display name; repeated clicks toggle ascending/descending. Switching from Status starts ascending. | None | None found |
| M03 | Sort by Status | Click header to sort by the five-state priority; repeated clicks toggle direction. | None | None found |
| M04 | Change table page, page size, next, or previous | Client pagination over the fully accumulated row array; default page size 25. Scroll-reset callback runs after page/page-size changes. | None directly | None found |
| M05 | Retry loading connector pages | Appears after a later server page fails. Retries the failed next page and is disabled during the request. | Repeats the relevant list reads. | Direct: retry and disabled state in `connectors-tab.test.tsx` |
| M06 | Open Explore more | Visible only with `Organization.McpConnector.Manage` or `.View`; hidden while unauthorized and skeletonized while permissions load. | Opens modal; catalog query becomes enabled. | None found |
| M07 | Set up connectors from empty state | Visible only to organization admins; opens `/aistudio/organization/{orgId}/connectors` in a new tab. Non-admins see contact-admin text. | Navigation only; the target implementation is outside this tab. | None found |
| M08 | Open a profile's action menu | One menu may be open at a time. | None | Busy-state rendering is covered; menu ownership is not |
| M09 | Open profile details | Clicking a row or choosing View details opens Preview Connector for that exact profile ID. | Enables catalog/provider and tool reads. | None found |
| M10 | Connect from row status or menu | Branches by connection state and credential type. First connect/enable is gated by one-time local consent. Duplicate profile actions are suppressed while pending. | See C01-C05 below. | Strong direct coverage for org connect, user OAuth start/pending/cancel, API-key pending, duplicate org connect, and disconnected re-enable |
| M11 | Disconnect from menu | Only shown when connected; disabled while the same profile is disconnecting. | See C06/L02. | Direct duplicate/busy coverage; CG hook success/failure coverage |
| M12 | Set as default | Only when the connector has multiple profiles and this profile is connected and not already default. | See C08/L04. | No direct mutation/UI test found; CG default derivation only |
| M13 | Add another profile | Visible only to AI Studio full users. Opens `/aistudio/organization/{orgId}/connectors` in a new tab. | Navigation only | None found |
| M14 | Revoke access | Visible only for revocable user OAuth credentials. No confirmation dialog. Disconnect and revoke are intentionally different: revoke deletes the stored credential/profile. | See C09/L05. | No direct UI or end-to-end mutation test found |

The table automatically drains every server page on mount until the backend total is reached or a page fails. This is observable behavior, not a user action. It has direct tests for preserving loaded rows, draining to the last page, stopping on failure, and manual retry.

### Explore connectors modal

| ID | User action | Availability and result | Backend effect | Existing direct coverage |
|---|---|---|---|---|
| E01 | Close modal | Close button, dialog dismissal, or Escape closes and resets search, category, page, page size, and filter-menu state. | Disables catalog query | None found |
| E02 | Search catalog | 300 ms debounce, resets to page 1, and forwards search to the server. | CG: GET connector catalog with `query`; legacy: GET apps with `search` | None found |
| E03 | Change catalog page/page size, next, or previous | Server pagination; default 16, options 16/32/64. | Re-fetches catalog with new offset/limit | None found |
| E04 | Select a connector card | Opens Preview Connector for the existing profile or a synthetic config for an unconfigured catalog app. | Enables preview reads | None found |

Category clear/search/filter/check actions exist in `ConnectorsNav`, but they are **not reachable from Manage Connectors on `main`** because the tab passes only `['All']`; `hasCategories` is false and the navigation is not rendered. They should not be counted as current user-facing actions.

### Preview Connector modal

| ID | User action | Availability and result | Backend effect | Existing direct coverage |
|---|---|---|---|---|
| P01 | Close preview | Closes Preview. If opened from Explore, Close also closes Explore. Resets tool search and pagination. | Disables preview reads | None found |
| P02 | Back to Explore | Only visible when opened from Explore. Closes Preview but leaves Explore open. | Disables preview reads; Explore query remains enabled | None found |
| P03 | Connect, re-enable, or authorize | Header action follows the five-state matrix. Hidden and replaced by Access required when profile status requires org access. Pending state blocks repeat clicks. Consent gate still applies. | See C01-C05/L01/L02 | No direct header-action callback test found |
| P04 | Disconnect | Visible for connected profiles; pending state blocks repeat clicks. | See C06/L02 | No direct preview callback test found |
| P05 | Search tools | Debounced client filter by raw tool name, display name, or description; resets to page 1. | None after tool list loads | None found |
| P06 | Change tool page/page size, next, or previous | Client pagination; default 10, options 10/25/50. | None | None found |
| P07 | Enable or disable all tools | Switch appears only while connected. It is disabled unless the profile is default, tools are loaded, and at least one tool exists. Sends the full admin-allowed tool set. | See C07/L03 | Count/switch-state rendering covered; callback mutation is not |
| P08 | Enable or disable one tool | Switch appears only for connected, default profiles and admin-allowed tools. Org-blocked or access-required tools are locked. | See C07/L03 | Lock/render cases covered; CG hook mutation semantics strongly covered; UI callback not |
| P09 | Retry tool loading | Appears after the tools query fails and is disabled while refetching. | Repeats tools GET | None found |
| P10 | Expand/collapse connector or tool description | Local `ExpandableText` action when content overflows. | None | None found |

### Consent and credential dialogs

| ID | User action | Availability and result | Backend effect | Existing direct coverage |
|---|---|---|---|---|
| A01 | Allow external connections | First connect/enable only. Writes boolean `true` to local storage key `allowConnectors`, then resumes the exact pending table/preview action. | The resumed action performs its normal mutation | Storage compatibility reads covered; continuation behavior not directly covered |
| A02 | Cancel consent | Cancels the pending action and performs no mutation. | None | None found |
| A03 | Enter API key | CG-only, user-level `api_key`, unauthenticated. Input is masked; whitespace-only input cannot submit. | None until submit | None found |
| A04 | Submit API key | Button or non-composing Enter. Trims key, blocks duplicate submission, cannot close while pending. | See C04 | Parent pending lifecycle covered; modal submission contract not directly covered |
| A05 | Cancel/close API-key dialog | Allowed only while no submission is pending; clears the API key and the profile pending marker. | None | Parent pending lifecycle covered |
| A06 | Complete provider OAuth | The app opens a pre-claimed popup, navigates it to the validated HTTPS authorization URL, polls unified profiles every 5 seconds, and times out after 120 seconds. | See C03/L01 plus provider OAuth callback outside this UI | OAuth transition, timeout, popup failure, and completion states covered |
| A07 | Cancel/close OAuth dialog | Closes the popup, clears pending state, and performs no follow-up enable in CG mode. | None beyond a request already initiated | Direct cancellation/pending-state coverage |
| A08 | Open sign-in page manually | Offered after popup failure or timeout when an authorization URL exists. Opens a new window and resumes polling. | Provider navigation only | Direct coverage for blocked-popup and timeout recovery |
| A09 | Done after OAuth success | Closes the success state. | None | Authentication completion covered |

## Backend operation catalog

### Connector Gateway on

| ID | Operation | Endpoint/body | User actions | Important server contract | Existing monorepo coverage |
|---|---|---|---|---|---|
| C00 | Load Manage Connectors rows | `GET /api/connector-gateway/v1/organization/{orgId}/profiles` plus `GET /api/connector-gateway/v1/organization/{orgId}/team/{teamId}/profiles/my` | Initial load, auto-drain, retry | Frontend joins org profiles to the current user's team profiles. Org pages use 100 rows; user enrichment requests up to 1000. | Direct adapter/page-fetch tests, including legacy-vs-CG selection and V2-flag request coalescing |
| C01 | Connect org-wide profile | `POST /api/connector-gateway/v1/organization/{orgId}/team/{teamId}/profiles/{orgProfileId}/connect`, no body | Connect for `credentialLevel=ORGANIZATION` | Creates/revives a team shell; successful status must be READY or CONNECTED. | Direct tab concurrency/dedup tests and hook test for org-profile creation before tool update |
| C02 | Re-enable retained user OAuth | Same POST connect route with `{kind:'oauth', name}` | Connect from `disconnected` | Gateway may reuse retained credential and return connected immediately. | Direct row test avoids OAuth; CG hook connect behavior is partially covered |
| C03 | Start user OAuth | Same POST connect route with `{kind:'oauth', name}` | Connect from `login_required` or OAuth `not_available` | Returns HTTPS `authorizationUrl` or an immediate connected result when a credential can be reused. | Direct URL validation, error, pending, popup, and authentication-transition tests |
| C04 | Connect user API key | Same POST connect route with `{kind:'api_key', name, description, apiKey}` | API-key dialog submit | Immediate profile creation; frontend treats response status ERROR as failure. | No focused modal/contract test found |
| C05 | Enable authenticated profile | Same POST connect route | Connect from `authenticated_not_runnable` | Connect creates/revives the concrete user profile. | CG hook connect test; table disconnected-profile test |
| C06 | Disconnect profile | `POST /api/connector-gateway/v1/organization/{orgId}/team/{teamId}/profiles/{userProfileId}/disconnect`, no body | Menu/preview Disconnect | Retains credential and selected tools. Already disconnected is a no-op; ERROR cannot disconnect. | Direct exact-body hook test and CG success/failure tests |
| C07 | Update selected tools | `PATCH /api/connector-gateway/v1/organization/{orgId}/team/{teamId}/profiles/{userProfileId}` with `{selectedTools:[...]}` | Toggle one/all tools | Replaces the full selected-tools list. Frontend serializes rapid changes and maintains optimistic state. Org profile may first require C01 to resolve a user profile ID. | Strong CG hook coverage for inherited tools, optimistic reconciliation, rapid/queued writes, failures, and cross-hook coordination |
| C08 | Set default profile | Same PATCH route with `{defaultProfile:true}` | Set as default | Only one profile per connector/user can be default. | Default derivation covered; mutation request/toast not directly covered |
| C09 | Revoke access | `DELETE /api/connector-gateway/v1/organization/{orgId}/team/{teamId}/profiles/{userProfileId}` | Revoke access | Generated contract says deleting one team sibling deletes all of that user's profiles for the same org profile across teams, with best-effort provider token revocation and credential cleanup. Org-wide shells reject delete; use disconnect. | No direct tab/hook mutation test found |
| C10 | Load Explore catalog | `GET /api/connector-gateway/v1/organization/{orgId}/connectors/` | Open/search/page Explore; provider label read | Server search and pagination | No direct Explore test found |
| C11 | Load preview tools | `GET /api/connector-gateway/v1/organization/{orgId}/tools/list/{connector}` | Open Preview, retry tools | Adapter converts CG tools into legacy UI shape | Adapter tests exist; no Preview retry/query-contract test found |

### Connector Gateway off

| ID | Operation | Endpoint/body | User actions | Important behavior | Existing monorepo coverage |
|---|---|---|---|---|---|
| L00 | Load Manage Connectors rows | `GET /api/mcp-gateway/v3/organization/{orgId}/team/{teamId}/profile/my/connectors` | Initial load, auto-drain, retry | Server pages of 100 are auto-drained by the tab. | Direct fetcher and tab auto-drain/error/retry tests |
| L01 | Start OAuth | `POST /api/mcp-gateway/v2/organization/{orgId}/team/{teamId}/profile/my/oauth` | Connect unauthenticated user profile | Returns authorization URL. After authentication, the frontend also performs L02 to attach/enable the profile for the agent. | Direct frontend OAuth pending/completion tests |
| L02 | Enable or disconnect profile | `PUT /api/organization/{orgId}/team/{teamId}/agents/{agentId}/config` with the full `connectors` map | Connect/re-enable/disconnect | Updates profile status/`availableProfileIds`; sends full map, so latest-cache composition matters. | Direct legacy post-auth tab test and hook test for back-to-back mutation composition; backend handler has no connector-specific assertion found |
| L03 | Update selected tools | Same user-agent-config PUT | Toggle one/all tools | Adds/removes tools for the target profile in the full connector map. | Hook path indirectly covered; no direct UI or connector-specific backend handler test found |
| L04 | Set default profile | Same user-agent-config PUT | Set as default | Updates `defaultProfileId` for the connector. | No direct mutation test found |
| L05 | Revoke access | First same user-agent-config PUT to remove/revoke the profile; only after that succeeds, `DELETE /api/mcp-gateway/v2/organization/{orgId}/team/{teamId}/profile/my/{profileId}` | Revoke access | Delete attempts provider OAuth-token revocation. Delete is skipped if agent-config cleanup fails, preventing drift. | No direct tab orchestration test found |
| L06 | Load Explore catalog | `GET /api/mcp-gateway/v2/organization/{orgId}/apps/` | Open/search/page Explore; provider label read | Server search, categories, pagination | No direct Explore test found |
| L07 | Load preview tools | `GET /api/mcp-gateway/v3/organization/{orgId}/team/{teamId}/functions/list/{appId}` with optional `profileId` | Open Preview, retry tools | Team-scoped, non-paginated tool list | Preview closed-state query suppression covered; no retry/query-contract test found |

## Minimum regression matrix

The smallest useful matrix crosses transport, profile state, credential shape, profile multiplicity, default status, permission, and request outcome.

1. Run all state-changing cases with `connector-gateway` both off and on where both modes support the action.
2. Cover all five connection states from the table and Preview.
3. Cover `credentialLevel=ORGANIZATION` and `USER`; for user credentials cover OAuth and API key.
4. Cover one profile, multiple profiles/non-default, and multiple profiles/default.
5. Cover admin-allowed tools, admin-blocked tools, all-functions-enabled inheritance, no tools, and tool-list failure.
6. Cover consent absent/Allow/Cancel and consent already stored.
7. Cover success, typed backend failure, duplicate click while pending, stale refetch, and a later-page read failure.
8. Explicitly verify destructive semantics: Disconnect retains credential/tools; Revoke removes the credential and, in CG, all team siblings for the same org profile.
9. Cover AI Studio full user versus restricted user for Add another profile; org admin versus non-admin for empty-state setup; MCP View/Manage permission versus neither for Explore more.
10. Run `actionagentmanageconnectorsv2` both off and on with Connector Gateway to verify identical rows/actions and only the expected request-count difference.

## Highest-priority test gaps

1. **Revoke orchestration:** no direct test verifies legacy cleanup-before-delete, CG delete target, cross-team deletion warning/expectation, failure handling, or absence of a confirmation dialog.
2. **Set default mutation:** no direct UI or request test for either transport.
3. **API-key submit contract:** no focused test for trimmed input, Enter, response `ERROR`, duplicate submit, close blocking, or CG request body.
4. **Tool-toggle UI wiring:** hook concurrency is well tested, but master/single switches are not tested end to end through Preview for both transports.
5. **Local table behavior:** connector search fields, sort directions/status order, pagination, and scroll reset have no direct tests.
6. **Explore flow:** permission gating, server search, pagination, card-to-preview transition, close/reset, and responsive variants have no direct tests.
7. **Preview navigation and recovery:** Close-versus-Back semantics, tool search/pagination, and Try again are untested.
8. **Consent continuation:** storage parsing is tested, but Allow/Cancel resuming or suppressing the exact pending table/preview action is not.
9. **Backend agent-config assertions:** backend API tests exercise generic config behavior but no connector-specific payload/update case was found.

## Source anchors

- UI orchestration: `frontend/src/components/agents/manage-tabs/connectors-tab.tsx`
- Row actions: `frontend/src/components/agents/manage-tabs/connector-table-row.tsx`
- Explore: `frontend/src/components/agents/manage-tabs/explore-connectors-modal.tsx`
- Preview/tool actions: `frontend/src/components/agents/manage-tabs/preview-connector-modal.tsx`
- Connection-state classifier: `frontend/src/components/connectors/utils.ts`
- Legacy operations: `frontend/src/hooks/react-query/agent-config/use-agent-connectors.ts`
- Connector Gateway operations: `frontend/src/hooks/react-query/mcp-gateway/use-cg-connectors.ts`
- Gateway HTTP hooks: `frontend/src/hooks/react-query/mcp-gateway/use-gateway.ts`
- Profile list adapter/fetcher: `frontend/src/hooks/react-query/mcp-gateway/manage-connectors-profiles.ts`
- Monorepo backend agent-config handler: `backend/agent/user_config_api.py`
- Generated external API contracts: `frontend/src/generated/mcp-gateway/sdk.gen.ts` and `types.gen.ts`
