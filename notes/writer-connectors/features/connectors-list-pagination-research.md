# Connectors list pagination research

**Status:** research only; no application code was changed.

**Measured:** 2026-08-19 from Jeffrey's reachable development identity against deployed dev APIs. The test host was
also probed, but the available dev identity received HTTP 401 and no host-specific test browser/auth state was present,
so a test-org dataset could not be measured in this session.

## Decision

Choose **(a): keep the drain, but render progressively as pages arrive**.

At the largest reachable dev dataset, both feature-flag paths require two 100-row pages and complete in under one
second at the median. That does not justify the contract and backend work required for server-side search, sort, and
pagination. Accepting the behavior without progressive rendering is also unnecessary: the query already exposes each
page as it arrives, and the existing client transformations produce the final canonical result once the drain
finishes.

This recommendation does not authorize implementation in this task. The current checked-out code already has the
essential option-(a) shape: it renders `allConfigs` after page one, continues `fetchNextPage`, and shows partial-load and
partial-error notices. A tech spec should preserve and explicitly test that behavior rather than redesigning the API.

Reconsider option (b) when a production-like measurement reaches either **more than 500 rows / five pages** or a
**greater than two-second median full drain**. Those are engineering review triggers, not product SLAs. At that point,
search semantics, total counts, stable ordering, and pagination would need an owned server contract.

## Measured target

The dev identity can reach two organizations:

- Org `1` (`Writer1`), 276 teams.
- Org `72717` (`Connector Test Org`), one team.

All 277 reachable teams were probed using a read-only first-page request on the legacy endpoint. Org `1`, team `66296`
was selected for the timed run:

- Flag off: 108 rows, tied for the largest reachable legacy dataset; pages contained 100 and 8 rows.
- Flag on: 137 organization profiles before team filtering; 134 rows survive filtering for team `66296`, tied for the
  largest reachable team-filtered result. Pages contained 100 and 37 organization rows.
- The flag-on user-profile request returned zero rows (`67` response bytes) for this identity/team.

The test environment was reachable at the network level but rejected the dev identity with HTTP 401. There was no
`frontend/playwright/.auth/test/` cache and no `frontend/tests/.env` from which to hydrate one. Consequently, “largest
reachable in dev/test” means the largest dataset actually reachable in this session: the dev target above. Test
numbers must be added when host-specific test auth is available; they must not be inferred from dev.

## Latency results

Method: five direct, sequential full-drain samples per flag state against deployed dev, with
`Cache-Control: no-cache`. Each sample used the same request shape as `fetchUnifiedUserProfilesPage`. For the
connector-gateway path, the organization and user-profile requests ran concurrently within each page, matching the
production `Promise.all`, while page 2 waited for page 1, matching the infinite-query drain.

| Flag state | Network shape per page | Rows / pages | First usable page, median | Full drain, median | Full-drain range |
|---|---|---:|---:|---:|---:|
| `connector-gateway = false` | one MCP Gateway v3 request | 108 / 2 | 0.539s | 0.92s | 0.82–1.91s |
| `connector-gateway = true` | CG org request + CG user request in parallel | 137 reported, 134 rendered / 2 | 0.444s | 0.88s | 0.83–0.94s |

Full-drain wall-clock samples:

- Flag off: `1.91s`, `1.07s`, `0.82s`, `0.92s`, `0.92s`.
- Flag on: `0.93s`, `0.88s`, `0.94s`, `0.83s`, `0.88s`.

Payload sizes from the fifth sample:

- Flag off: 206,929 bytes for page 1 and 11,845 bytes for page 2 (218,774 bytes total).
- Flag on: 221,311 and 77,163 organization-profile bytes, plus two repeated 67-byte empty user-profile responses
  (298,608 bytes total).

These are API-path measurements, not browser navigation-to-paint measurements. Browser automation and authenticated
Playwright state were unavailable, so React render time was not measured. The first-page value is the earliest point
at which the checked-out component can render connector rows, not a claimed visual performance metric.

## Current contract and progressive-render requirements

`useListUnifiedUserProfiles` uses 100-row offsets. `ConnectorsTab` flattens the pages received so far, applies the same
search and status/name sorting to that accumulated set, then slices the current client page. An effect requests the
next server page until `hasNextPage` is false.

Option (a) should preserve these invariants:

1. The initial skeleton ends when page 1 succeeds; it must not wait for the full drain.
2. Rows, search, sort, and client pagination operate on all pages received so far.
3. While pages remain, the UI states that results may be incomplete.
4. A later-page failure keeps already loaded rows visible and offers retry.
5. After the final page, search, sort, counts, and pagination are byte-for-byte/ordering-equivalent to applying today's
   transformations to the fully drained array.
6. A changing result set must not strand the user on an empty client page; clamp or reset the client offset when the
   loaded-page count or search term changes.

The existing unit coverage exercises automatic draining, partial-load messaging, retry, and completion. The tech spec
should add an explicit equivalence fixture whose records span at least two server pages and verifies that final search
and both sort directions match the fully materialized baseline.

## OAuth polling compatibility

`ConnectConnectorModal` also calls `useListUnifiedUserProfiles` and polls via `refetch`. The hook and query key should
remain unchanged for option (a). In TanStack Query, refetching an infinite query refreshes its loaded pages; changing
the shared hook to return only page 1 or moving drain ownership into a page-specific replacement hook could prevent the
modal from finding a selected connector on a later loaded page.

The safest scope is therefore presentation/derived-state behavior in `ConnectorsTab`, not a semantic change to
`useListUnifiedUserProfiles`. If the tech spec proposes a new page-local wrapper, the modal must continue using the
original infinite-query contract and its polling behavior needs focused regression coverage.

## Risks and follow-ups

- **Reported count is wrong after team filtering in the flag-on path.** `fetchUnifiedUserProfilesPage` filters the org
  result by `teamIds`, then `adaptCgV1ProfilesResponse` retains `orgResponse.totalCount`. For the measured team this is
  137 reported versus 134 renderable. The drain can therefore request based on rows the team will never see. This is a
  correctness issue for any future server-side pagination contract and should be resolved before option (b).
- **The user-profile request is repeated for every org page.** It requests offset 0 / limit 1000 each time. The measured
  response was empty and cheap, but the fan-out cost grows with both org page count and a user's profile count.
- **Progressive search is intentionally incomplete.** Results can appear or move as later pages arrive. The visible
  notice is part of correctness, not optional polish.
- **Sort stability is not explicit.** Equal name/status comparisons return zero, so final order depends on server page
  order. A server-side design would need a deterministic tie-breaker.
- **Test remains unmeasured.** Repeat the five-sample procedure with host-specific test auth before treating these dev
  numbers as release-environment evidence.

## Tech-spec acceptance criteria

- Page 1 rows render before page 2 resolves in both feature-flag states.
- The partial-results notice is visible and programmatically perceivable while draining.
- A page-2 failure preserves page-1 rows and retry continues the drain.
- Once drained, search and name/status sort results exactly match the current full-array behavior.
- Client pagination remains valid as pages append and as a search narrows results.
- OAuth polling still observes an authenticated connector located beyond the first loaded server page.
- Measurements are repeated in test with a host-specific authenticated identity and recorded alongside these dev
  results.

## Source anchors

- `frontend/src/hooks/react-query/mcp-gateway/use-gateway.ts` — `fetchUnifiedUserProfilesPage` and
  `useListUnifiedUserProfiles`.
- `frontend/src/hooks/react-query/mcp-gateway/connector-gateway-adapter.ts` — flag-on response adaptation and count
  preservation.
- `frontend/src/components/agents/manage-tabs/connectors-tab.tsx` — drain effect, accumulated transforms, progressive
  list, and partial-page notices.
- `frontend/src/components/agents/manage-tabs/connect-connector-modal.tsx` — OAuth polling via `refetch`.
- `frontend/src/components/ui/manage-agent/manage-agent-page-skeleton.tsx` — initial connector loading UI.
- `frontend/src/components/agents/manage-tabs/connectors-tab.test.tsx` — current progressive-drain coverage.
