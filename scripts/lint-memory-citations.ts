import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { analyzeMemoryFile, isMemoryTier, MEMORY_TIERS } from '../src/shared/memory-catalogue.js';

type Metadata = { load: 'core' | 'context' | 'archive'; keywords: string[]; refs: string[] };
type Entry = { id: number; title: string };
const fileTiers = new Map<string, string>();

const sharedDirectory = join(process.cwd(), 'docs/shared-memory');
const knowledgeDirectory = join(homedir(), 'Documents/Workbench/notes/knowledge');
const metadata: Record<string, Metadata> = {
  'engineering-standards.md': { load: 'core', keywords: ['TypeScript conventions', 'feature flags'], refs: ['working-with-jeffrey.md'] },
  'integration-constraints.md': { load: 'core', keywords: ['Tailscale', 'Slack Workflow Builder'], refs: [] },
  'migration-log.md': { load: 'archive', keywords: ['2026-08-23 consolidation'], refs: [] },
  'verification-and-debugging-method.md': { load: 'core', keywords: ['root-cause validation', 'PR review'], refs: ['workbench-operating-practices.md'] },
  'workbench-frontend-lessons.md': { load: 'context', keywords: ['buildId toast', 'virtualized row height'], refs: ['workbench-product-decisions.md'] },
  'workbench-operating-practices.md': { load: 'core', keywords: ['task queue stack', 'artifact publishing'], refs: ['verification-and-debugging-method.md'] },
  'workbench-product-decisions.md': { load: 'core', keywords: ['ProjectColorDot', '/api/realtime'], refs: ['workbench-frontend-lessons.md'] },
  'working-with-jeffrey.md': { load: 'core', keywords: ['Jeffrey voice', 'ownership confirmation'], refs: ['engineering-standards.md'] },
  'writer-context.md': { load: 'context', keywords: ['Writer connectors', 'PLUTO exclusion'], refs: [] },
  'ashley-connectors-rewrite-chat-prep.md': { load: 'context', keywords: ['Ashley rewrite prep'], refs: [] },
  'connector-e2e-test-coverage-plan.md': { load: 'context', keywords: ['connector E2E coverage'], refs: [] },
  'fe-web-app-stack-migration.md': { load: 'context', keywords: ['fe.web-app migration'], refs: ['writer-frontend-stack.md'] },
  'open-questions.md': { load: 'context', keywords: ['onboarding unknowns'], refs: [] },
  'writer-be-mcp-gateway-local-setup.md': { load: 'context', keywords: ['bun 1.3.14', 'Baseten mock embedding'], refs: ['writer-repo-and-environment-map.md'] },
  'writer-branching-and-deploy.md': { load: 'core', keywords: ['GitHub merge queue', 'pinned promotion tag'], refs: ['writer-tooling-and-process.md'] },
  'writer-connectors-action-catalog.md': { load: 'core', keywords: ['nine connector writes', 'ConnectorsTab actions'], refs: ['writer-connectors-page-map.md'] },
  'writer-connectors-page-map.md': { load: 'core', keywords: ['query-key map', 'route component map'], refs: ['writer-connectors-action-catalog.md'] },
  'writer-connectors-permission-model.md': { load: 'core', keywords: ['org hard ceiling', 'Experian ROPC'], refs: ['writer-mcp-backend-design.md'] },
  'writer-connectors-team.md': { load: 'context', keywords: ['Kapil Duraphe', 'connectors roster'], refs: ['writer-onboarding-resource-map.md'] },
  'writer-fe-web-app-local-setup.md': { load: 'context', keywords: ['WRITER_AGENT_URL', 'Vite 5173'], refs: ['writer-repo-and-environment-map.md'] },
  'writer-frontend-stack.md': { load: 'core', keywords: ['WDS Storybook', 'TanStack Query'], refs: ['fe-web-app-stack-migration.md'] },
  'writer-managed-mac-constraints.md': { load: 'context', keywords: ['managed Mac'], refs: [] },
  'writer-mcp-backend-design.md': { load: 'core', keywords: ['MCP backend design'], refs: ['writer-connectors-permission-model.md'] },
  'writer-monorepo-local-fullstack-worktrees.md': { load: 'context', keywords: ['scripts/worktree.py', 'local-connector-stack'], refs: [] },
  'writer-observability-tooling.md': { load: 'context', keywords: ['Langfuse', 'OpenTelemetry emission'], refs: [] },
  'writer-onboarding-resource-map.md': { load: 'context', keywords: ['Writer onboarding map'], refs: ['writer-connectors-team.md'] },
  'writer-product-surfaces.md': { load: 'context', keywords: ['skynet deployments', 'Agent Studio'], refs: [] },
  'writer-repo-and-environment-map.md': { load: 'core', keywords: ['five connector repos', 'prod org 3002'], refs: ['writer-be-mcp-gateway-local-setup.md', 'writer-fe-web-app-local-setup.md'] },
  'writer-tooling-and-process.md': { load: 'core', keywords: ['CON-194 split', 'pre-push hook'], refs: ['writer-branching-and-deploy.md'] },
};
const errors: string[] = [];

async function collect(directory: string) {
  const entries = new Map<string, Entry[]>();
  const sources = new Map<string, string>();
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.md') && name !== 'index.md').sort()) {
    const source = await readFile(join(directory, file), 'utf8');
    sources.set(file, source);
    const analysis = analyzeMemoryFile(source);
    const tier = analysis.tier;
    if (!isMemoryTier(tier)) errors.push(`${file} needs a first-line header "tier: ${MEMORY_TIERS.join(' | ')}"${tier ? ` (found "${tier}")` : ''}.`);
    else fileTiers.set(file, tier);
    if (analysis.hasUnnumberedHeading) errors.push(`${file} has an unnumbered entry heading.`);
    if (analysis.duplicateEntryNumbers.length) errors.push(`${file} has duplicate entry IDs.`);
    entries.set(file, analysis.entries);
  }
  return { entries, sources };
}

function render(title: string, entries: Map<string, Entry[]>) {
  const rows = [...entries.keys()].map((file) => {
    const item = metadata[file];
    if (!item) { errors.push(`${file} has no catalogue metadata.`); return ''; }
    const refs = item.refs.length ? item.refs.map((ref) => `\`${ref}\``).join(', ') : '—';
    return `| \`${file}\` | ${entries.get(file)?.length ?? 0} | ${fileTiers.get(file) ?? ''} | ${item.load} | ${item.keywords.join('; ')} | ${refs} |`;
  });
  return `# ${title} catalogue\n\nRead these rows first, then open only matching files. Entry counts are generated from numbered headings by \`npm run memory:catalogue\`; never edit them by hand.\n\n| Path | Entries | Tier | Load | Keywords (owned here) | Cross-refs |\n| --- | ---: | --- | --- | --- | --- |\n${rows.join('\n')}\n`;
}

const [shared, knowledge] = await Promise.all([collect(sharedDirectory), collect(knowledgeDirectory)]);
const allEntries = new Map([...shared.entries, ...knowledge.entries]);
for (const [file, source] of [...shared.sources, ...knowledge.sources]) for (const target of analyzeMemoryFile(source).citations) {
  if (!allEntries.get(target.file)?.some(({ id }) => id === target.entry)) errors.push(`${file} has dangling citation [${target.file}#${target.entry}].`);
}
const owners = new Map<string, string>();
for (const [file, item] of Object.entries(metadata)) {
  for (const keyword of item.keywords.map((keyword) => keyword.toLowerCase())) {
    const owner = owners.get(keyword);
    if (owner) errors.push(`keyword "${keyword}" is owned by both ${owner} and ${file}.`);
    owners.set(keyword, file);
  }
  for (const ref of item.refs) {
    if (!metadata[ref]) errors.push(`${file} cross-refers to missing ${ref}.`);
    else if (!metadata[ref].refs.includes(file)) errors.push(`${file} → ${ref} is not reciprocal.`);
  }
}
const sharedCatalogue = render('Shared Workbench memory', shared.entries);
const knowledgeCatalogue = render('Knowledge', knowledge.entries);
const writeCatalogues = process.argv.includes('--write-catalogues');
if (writeCatalogues && !errors.length) await Promise.all([
  writeFile(join(process.cwd(), 'docs/shared-memory.md'), sharedCatalogue),
  writeFile(join(knowledgeDirectory, 'index.md'), knowledgeCatalogue),
]);
if (!writeCatalogues) {
  const [actualShared, actualKnowledge] = await Promise.all([
    readFile(join(process.cwd(), 'docs/shared-memory.md'), 'utf8'),
    readFile(join(knowledgeDirectory, 'index.md'), 'utf8'),
  ]);
  if (actualShared !== sharedCatalogue) errors.push('docs/shared-memory.md does not match its generated catalogue.');
  if (actualKnowledge !== knowledgeCatalogue) errors.push('knowledge/index.md does not match its generated catalogue.');
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Memory catalogues are valid across ${allEntries.size} files.`);
