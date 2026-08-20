# GET /api/connector-gateway/v1/organization/{orgId}/team/{teamId}/profiles/my — Research & Tech Spec Notes

**Status:** Research complete (2026-08-19)  
**Authored for:** Manage Connectors V2 tech spec  
**Scope:** Understanding the `/profiles/my` endpoint, its current usage, and viability as a single unified data source

---

## Executive Summary

The `/profiles/my` endpoint exists and is **already in use** in the frontend via `fetchCgUserProfilesPage()` in `cg-profiles-service.ts`. However, the current architecture still requires **two parallel requests** to render the connector list:

1. **Org profiles** (`GET /organization/{orgId}/profiles`) — admin-configured connector definitions
2. **User profiles** (`GET /organization/{orgId}/team/{teamId}/profiles/my`) — user-level authentication state

These are merged in the adapter (`adaptCgV1ProfilesResponse`) to produce the UI result. The question is whether `/profiles/my` alone could serve both roles to eliminate the second request.

---

## Current Data Flow

### Request Layer (`fetchUnifiedUserProfilesPage`)

```typescript
// frontend/src/hooks/react-query/mcp-gateway/use-gateway.ts
const [orgData, userData] = await Promise.all([
  fetchCgOrgProfilesPage(orgId, params, signal),           // org-level config
  fetchCgUserProfilesPage(orgId, teamId, {...}, signal),   // team+user scoped
]);
```

Both requests run in parallel, then the results are combined by `adaptCgV1ProfilesResponse`.

### Endpoint Contracts

#### `/profiles` (Organization Profiles)
**Returns:** Admin-configured connector profiles scoped to the organization

| Field | Present | Purpose |
|-------|---------|---------|
| `id` | ✓ | Org profile UUID |
| `connectorId` | ✓ | Reference to the connector catalog |
| `name` | ✓ | Profile display name |
| `description` | ✓ | Profile description |
| `displayName` | ✓ | Connector display name |
| `authMode` | ✓ | Security scheme (none, api_key, code_grant, dcr, client_credentials, http_basic) |
| `scopes` | ✓ | OAuth scopes required for the connector |
| `status` | ✓ | Connection status (CONNECTED, READY, DISCONNECTED, etc.) |
| `orgWideAuth` | ✓ | Boolean: is org-level or user-level credential |
| `allowedTools` | ✓ | Array of tools available in this profile |
| `writerManagedCredentialId` | ✓ | Whether Writer manages the credential |
| `teamIds` | ✓ | Which teams can use this profile |
| `tenantUrl`, `privateEndpointId`, `ekmVaultRef`, `oauthDiscoveryOverride`, `additionalHeaders` | ✓ | Advanced configuration (dropped by adapter) |
| **Total fields:** | | ~18 fields (some advanced/dropped by adapter) |

#### `/profiles/my` (Team+User Scoped Profiles)
**Returns:** Merged view of user authentication state within a team

| Field | Present | Purpose |
|-------|---------|---------|
| `id` | ✓ | User profile UUID |
| `orgProfileId` | ✓ | Reference back to the org profile this user connected |
| `orgId` | ✓ | Organization ID |
| `teamId` | ✓ | Team ID (scoping filter) |
| `name` | ✓ | User-supplied name (may differ from org profile) |
| `description` | ✓ | User-supplied description |
| `createdBy` | ✓ | User ID who created this connection |
| `selectedTools` | ✓ | Tools the user enabled (subset of `allowedTools`) |
| `defaultProfile` | ✓ | Boolean: is this the user's default profile for this connector |
| `status` | ✓ | User's connection status (mirrors org profile or separate) |
| `createdAt`, `updatedAt` | ✓ | Timestamps |
| **Connector data** | ✓ | Nested: logo, name, description, displayName |
| **Missing (vs org profiles):** | — | `authMode`, `scopes`, `orgWideAuth`, `allowedTools`, `writerManagedCredentialId`, `teamIds`, `ekmVaultRef`, etc. |
| **Total fields:** | | ~13 fields (subset of org profile data) |

---

## Current Adapter Merging Logic

### `adaptCgV1ProfilesResponse` Pattern

1. **Org profiles are the base** — all UI rows start from org profiles
2. **User profiles enrich** — for each org profile, the adapter looks for a matching user profile:
   - **Primary join:** by `orgProfileId` (exact match)
   - **Fallback join:** by connector name (legacy compatibility)
3. **User data overrides org data:**
   - `authenticated` / `status` — replaced with user's auth state
   - `selectedTools` — replaced with tools the user enabled
   - `defaultProfile` — set to user's default flag
   - `credentialUpdatedAt` — user's last credential update
   - `userProfileId` — user profile ID for mutations
4. **No match** → marked as unauthenticated PENDING (awaiting user connection)

**Result:** A unified `UserProfileConnector[]` that represents "org-defined connectors, annotated with team+user state."

---

## Field-Loss Analysis

Per [connector-gateway-adapter-field-loss.md](./connector-gateway-adapter-field-loss.md), the `/profiles/my` endpoint loses:

| Category | Loss | Impact | Design go/no-go |
|----------|------|--------|-----------------|
| **Org config** | `authMode`, `allowedTools`, `scopes`, `writerManagedCredentialId`, `orgWideAuth`, `ekmVaultRef`, `tenantUrl`, `privateEndpointId`, etc. | Connector type, OAuth discovery, credential mode, tool catalog, tenant config | **NO-GO** (not in `/profiles/my`) |
| **Team visibility** | `teamIds` from org profile | Checking if profile is available to this team | **CONDITIONAL** (org field survives, user field dropped) |
| **Status/auth** | Normalized via lossy `status` + `authenticated` mapping | "User connected" vs "awaiting connection" | **CONDITIONAL** |

---

## Three Architecture Options for the Tech Spec

### Option A: Keep current two-request approach (Status quo)
- **Pros:**
  - Already implemented and tested
  - Cleanly separates org config from user state
  - Field loss is well-documented in adapter
  - Supports both `connector-gateway` flag states
- **Cons:**
  - Two parallel requests = slower perceived load time (especially mobile)
  - More complex merging logic
  - `/profiles/my` is underutilized

### Option B: Enrich `/profiles/my` on the backend to include org profile fields
- **Requires:** Backend change to `/profiles/my` endpoint
  - Return full org profile fields (authMode, scopes, allowedTools, etc.)
  - Alongside user-state fields (selectedTools, defaultProfile, status)
  - Still scoped to the given `teamId`
- **Pros:**
  - Single unified request
  - No adapter field loss (all data in one payload)
  - Faster page load (one network call instead of two)
  - Clearer semantics: "give me the org+user profile for this team"
- **Cons:**
  - Backend schema change (mutation to existing endpoint contract)
  - Potential breaking change for other `/profiles/my` consumers
  - Needs verification that backend supports this enrichment

### Option C: New unified endpoint (e.g., `/profiles/unified` or similar)
- **Requires:** New backend endpoint
  - Combines org + user profile data by design
  - No adapter needed
- **Pros:**
  - Cleanest design; no ambiguity about what the response contains
  - Single request
  - Can be feature-flagged independently
- **Cons:**
  - Largest backend effort
  - Coordination across teams (connector-gateway owners)
  - Another endpoint to maintain

---

## Current Frontend Usage

### Where `/profiles/my` is used

1. **`fetchCgUserProfilesPage`** — Primary call site (already in use)
   - File: `frontend/src/lib/connectors/cg-profiles-service.ts:34-46`
   - Always fetched when `useConnectorGateway` flag is true
   - Merged immediately with org profiles in `fetchUnifiedUserProfilesPage`

2. **Type definition** — Generated SDK provides full type safety
   - Type: `GetApiConnectorGatewayV1OrganizationByOrgIdTeamByTeamIdProfilesMyResponse`
   - Generated from OpenAPI spec
   - No code generation issues

3. **Mock data** — Minimal mocking needed
   - File: `frontend/tests/utils/local-mocks/local-connector-contract-smoke-mocks.ts`
   - Only mocked for local E2E tests

### Performance Impact

**Current two-request waterfall:**
```
Network timeline (sequential if not parallelized):
  Request 1: GET /organization/{orgId}/profiles
  Request 2: GET /organization/{orgId}/team/{teamId}/profiles/my
  Merge in JS adapter
  UI renders
```

**With Option B (single request):**
```
Network timeline:
  Request 1: GET /organization/{orgId}/team/{teamId}/profiles/my (enriched)
  No merge needed (or minimal merge)
  UI renders
  (Save ~1 network RTT + merge time)
```

---

## Recommendation for Tech Spec

**Option B is recommended** with these conditions:

1. **Verify backend feasibility** — Confirm that `be.mcp-gateway` can enrich `/profiles/my` without breaking other consumers
2. **Document the new contract** — Update OpenAPI spec with full field list (org + user fields)
3. **Adapt frontend adapter** — If `/profiles/my` now returns org fields, reduce or eliminate field loss
4. **Feature-flag if needed** — If this is a breaking change, gate behind a flag or version
5. **Update this research doc** — Record the backend decision and schema delta

### Decision: Option A (Status quo) — 2026-08-19

**Endpoint availability clarified:** The backend already provides `GET /api/connector-gateway/v1/organization/{orgId}/team/{teamId}/profiles/my/unified`, but the team has decided **not to use it**. The `/unified` endpoint exists as an option but is being deprioritized.

**Decision made:** Keep the current two-request approach (org profiles + `/profiles/my`). The org profile search endpoint remains open and available.

**Rationale:**
- Current approach is already implemented, tested, and understood
- Adapter field loss is well-documented and design is working within it
- Single-endpoint unification (`/unified`) not worth the context switch at this stage of V2

**Impact on tech spec:** No blocking dependency. Design and frontend implementation can proceed with existing two-query pattern.

---

## Next Steps

1. **Frontend development** (owner: This engineer)
   - Implement Manage Connectors V2 using existing two-request pattern
   - Verify adapter field loss does not impact V2 design
   - No backend schema changes required

2. **Performance monitoring** (future work)
   - Measure waterfall impact of two parallel requests on mobile
   - If load time becomes an issue in production, revisit `/unified` or backend enrichment

---

## References

- **Endpoint types:** `frontend/src/generated/mcp-gateway/types.gen.ts`
- **Current usage:** `frontend/src/lib/connectors/cg-profiles-service.ts`
- **Adapter logic:** `frontend/src/hooks/react-query/mcp-gateway/connector-gateway-adapter.ts`
- **Field loss inventory:** `docs/initiatives/connectors/connector-gateway-adapter-field-loss.md`
- **Connectors page map:** `docs/initiatives/connectors/connectors-page-map.md`
