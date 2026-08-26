## Objective

- Stop Manage Connectors from issuing redundant list reads on mount and after connector mutations.
- Preserve pagination correctness as prework for the Connector V2 page.

## Decision Log

| Date | Decision | Why | Impact |
| --- | --- | --- | --- |
| 2026-08-25 | Fetch further unified-profile pages only when the selected UI page or an active client-side search needs them. | The former `hasNextPage` effect drained every 100-row API page on mount and after invalidation. | Initial load stays on the first page; navigation remains capable of reaching the server-reported total. |
| 2026-08-25 | Render a status state for an unloaded selected page and return to loaded rows after an unrecoverable page failure. | Direct page selection must not expose an empty table while a fetch is pending or impossible. | Pagination is safe for V2 reuse. |
| 2026-08-25 | Disable the legacy agent-connectors query while Connector Gateway is active and trim multi-page infinite cache before mutation invalidation. | Both eliminate inactive/replayed reads without changing the Connector Gateway authority. | Connect/disconnect refreshes page one; later pages are requested only on demand. |

## Verification

- `pnpm --dir frontend exec vitest run src/components/agents/manage-tabs/connectors-tab.test.tsx src/hooks/react-query/mcp-gateway/use-gateway.test.ts` — passed: 27 tests.
- `pnpm --dir frontend exec prettier --check ...` — passed for all changed frontend files.
- `pnpm --dir frontend exec eslint ...` — passed for all changed frontend files after removal of a stale unused import.
- `pnpm --dir frontend type-check` — no diagnostics observed; the command wrapper did not return a final completion status.

## Handoff

- Core page: `/Users/jeffrey.lu/dev/writer-monorepo/frontend/src/components/agents/manage-tabs/connectors-tab.tsx`
- Query ownership: `/Users/jeffrey.lu/dev/writer-monorepo/frontend/src/hooks/react-query/mcp-gateway/use-gateway.ts`
- Tests: `/Users/jeffrey.lu/dev/writer-monorepo/frontend/src/components/agents/manage-tabs/connectors-tab.test.tsx`, `/Users/jeffrey.lu/dev/writer-monorepo/frontend/src/hooks/react-query/mcp-gateway/use-gateway.test.ts`
