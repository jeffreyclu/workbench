# Workbench Instructions

- Use TypeScript and React for product code.
- Keep the core work-item model provider-neutral. Linear-specific fields belong in provider metadata or sync records.
- SQLite is the local source of truth for manual fields, priority, strategy, and agent assignments.
- Never overwrite locally owned fields during provider sync.
- Treat accessibility, keyboard navigation, responsive behavior, and visible loading/error states as requirements.
- Run `npm run typecheck`, `npm test`, and `npm run build` after material changes.
- Read `docs/assistant-context.md` before changing assistant-facing APIs.
