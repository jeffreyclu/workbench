# Writer acronym research

Date: 2026-08-25  
Scope: Writer Agent / AI Studio / connectors terminology.  
Method: searched accessible Slack messages and Confluence pages, then checked the applicable
`writer-monorepo` documentation and source. This is a working glossary, not a claim that every
capitalized string in the company has one global meaning.

## Confirmed terms

| Acronym / term | Expansion | Meaning and writing guidance |
| --- | --- | --- |
| AIS | AI Studio | The AI Studio product surface. Use “AI Studio” at first mention outside an AIS-specific context. |
| WA | Writer Agent | The current product name, historically Action Agent. Prefer “Writer Agent” in formal and user-facing material. |
| ABv1 | Agent Builder version 1 | The legacy Writer Framework deployment path. |
| ABv2 | Agent Builder version 2 | The current container-based Agent Builder deploy platform. “v2” is a version label, not a separate product name. |
| CG | Connector Gateway | The newer connector API surface. It is distinct from the legacy `mcp-gateway` API surface, despite both being served by `be.mcp-gateway`. |
| MCP | Model Context Protocol | The protocol/tool surface used for external integrations and internal tooling. |
| WDS | Writer Design System | Writer’s shared UI component and design-token library, published as `@writercolab/fe.wds`. |
| EKM | Encryption Key Management | The organization-encryption system used for protected data and credentials; “EKM SDK” refers to its client library. **Corrected 2026-08-25**: a follow-up session found every in-repo source (`docs/ekm-fields.md`, `backend/services/ekm/README.md`, `docs/features/ekm-message-encryption.md`) spells this "Encryption," not "Enterprise" as originally recorded here. |
| RAG | retrieval-augmented generation | The knowledge-retrieval capability that can ground an agent answer. It is not the name of one UI surface. |
| LLM | large language model | The inference/model layer. Writer Agent orchestrates LLMs, tools, and product behavior; the terms are not interchangeable. |
| WfP | Workers-for-Platforms | Cloudflare's multi-tenant Worker isolation product, referenced for Agent Builder's deploy-path consolidation (`docs/cloudflare/agent-builder-map.md`, `docs/initiatives/action-agent-architecture-consolidation/`). |
| BYOK | Bring Your Own Key | Customer-supplied model/API credentials rather than Writer-provided ones (`CHANGELOG.md`, `EKM_BYOK_ORG_ID_AWS/AZURE/GCP` in `frontend/tests/utils/e2e-auth-storage-validation.ts`). No verbatim in-repo spell-out was found; this is the standard industry expansion, high-confidence but not text-confirmed. |
| WE | (unconfirmed) | Jira project-key prefix for a different Jira project than ACTION, e.g. `WE-18444` in `docs/releases/*.md`. Usage pattern only — the expansion itself is not confirmed. |
| GHA / GHCR | GitHub Actions / GitHub Container Registry | Generic, not Writer-specific; used in `docs/testing/smokestack-ci.md` and `docs/testing/playwright-e2e-ghcr-image.md`. |

## Related names that are not additional acronyms

- **Skynet** is the deployment/service family for Writer Agent: for example `skynet-frontend` and
  `skynet-backend`. It is not a separate user-facing product.
- **Action Agent** is the former product name for Writer Agent, not an acronym.
- **`mcp-gateway`** is a legacy API surface and service-repository name; it is not a synonym for CG.
- **“Agent Studio”** is unconfirmed and should not be introduced in written work. The best-supported
  reading is spoken shorthand for Agent Builder.

## Evidence

The research directly searched both requested internal sources. Representative accessible records:

- Confluence: [AI Studio](https://writerai.atlassian.net/wiki/spaces/CE/pages/4501438521/AI+Studio);
  [Agent Builder v2 feature flags](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4725571739/Agent+Builder+v2+feature+flags);
  [Using Figma MCP to Build WRITER UI](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4829413419/Using+Figma+MCP+to+Build+WRITER+UI);
  and [ABv1 to ABv2 Migration: Open Questions and Scope Confirmation](https://writerai.atlassian.net/wiki/spaces/ENG/pages/4788715880/ABv1+to+ABv2+Migration+Open+Questions+and+Scope+Confirmation).
- Slack: current `#team-mcp`, `#xfn-eng-mcp-wa`, and `#wds-foundations-team` conversations use CG,
  MCP, WA, ABv2, WDS, and EKM with the expansions above. The Writer Agent rename is recorded in the
  [2025-10-31 release note](https://grid-writerai.enterprise.slack.com/archives/CD20VL988/p1761943231556569?thread_ts=1761943231.556569&cid=CD20VL988).
- Repository cross-checks: `docs/features/agent-builder-v2.md`,
  `docs/cloudflare/agent-builder-map.md`, `docs/development/figma-mcp-ui-workflow.md`,
  `docs/architecture/overview.md`, `docs/architecture/writer-monorepo-observability.md`, and
  `frontend/src/generated/mcp-gateway/sdk.gen.ts`.

## Boundaries

- Avoid treating a repeated internal abbreviation as a permanent public product name.
- Expand a term on first use when readers may not share the local context.
- Preserve the `connector-gateway` / `mcp-gateway` distinction. They are related but not aliases.
