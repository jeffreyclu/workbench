import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Metadata = { tier: 'core' | 'context' | 'archive'; keywords: string[]; refs: string[] };
type Entry = { id: number; title: string };

const sharedDirectory = join(process.cwd(), 'docs/shared-memory');
const knowledgeDirectory = join(homedir(), 'Documents/Workbench/notes/knowledge');
const metadata: Record<string, Metadata> = {
  'engineering-standards.md': { tier: 'core', keywords: ['TypeScript conventions', 'feature flags'], refs: ['working-with-jeffrey.md'] },
  'integration-constraints.md': { tier: 'core', keywords: ['Tailscale', 'Slack Workflow Builder'], refs: [] },
  'migration-log.md': { tier: 'archive', keywords: ['2026-08-23 consolidation'], refs: [] },
  'verification-and-debugging-method.md': { tier: 'core', keywords: ['root-cause validation', 'PR review'], refs: ['workbench-operating-practices.md'] },
  'workbench-frontend-lessons.md': { tier: 'context', keywords: ['buildId toast', 'virtualized row height'], refs: ['workbench-product-decisions.md'] },
  'workbench-operating-practices.md': { tier: 'core', keywords: ['task queue stack', 'artifact publishing'], refs: ['verification-and-debugging-method.md'] },
  'workbench-product-decisions.md': { tier: 'core', keywords: ['ProjectColorDot', '/api/realtime'], refs: ['workbench-frontend-lessons.md'] },
  'working-with-jeffrey.md': { tier: 'core', keywords: ['Jeffrey voice', 'ownership confirmation'], refs: ['engineering-standards.md'] },
  'writer-context.md': { tier: 'context', keywords: ['Writer connectors', 'PLUTO exclusion'], refs: [] },
  'ashley-connectors-rewrite-chat-prep.md': { tier: 'context', keywords: ['Ashley rewrite prep'], refs: [] },
  'connector-e2e-test-coverage-plan.md': { tier: 'context', keywords: ['connector E2E coverage'], refs: [] },
  'fe-web-app-stack-migration.md': { tier: 'context', keywords: ['fe.web-app migration'], refs: ['writer-frontend-stack.md'] },
  'open-questions.md': { tier: 'context', keywords: ['onboarding unknowns'], refs: [] },
  'writer-be-mcp-gateway-local-setup.md': { tier: 'context', keywords: ['bun 1.3.14', 'Baseten mock embedding'], refs: ['writer-repo-and-environment-map.md'] },
  'writer-branching-and-deploy.md': { tier: 'core', keywords: ['GitHub merge queue', 'pinned promotion tag'], refs: ['writer-tooling-and-process.md'] },
  'writer-connectors-action-catalog.md': { tier: 'core', keywords: ['nine connector writes', 'ConnectorsTab actions'], refs: ['writer-connectors-page-map.md'] },
  'writer-connectors-page-map.md': { tier: 'core', keywords: ['query-key map', 'route component map'], refs: ['writer-connectors-action-catalog.md'] },
  'writer-connectors-permission-model.md': { tier: 'core', keywords: ['org hard ceiling', 'Experian ROPC'], refs: ['writer-mcp-backend-design.md'] },
  'writer-connectors-team.md': { tier: 'context', keywords: ['Kapil Duraphe', 'connectors roster'], refs: ['writer-onboarding-resource-map.md'] },
  'writer-fe-web-app-local-setup.md': { tier: 'context', keywords: ['WRITER_AGENT_URL', 'Vite 5173'], refs: ['writer-repo-and-environment-map.md'] },
  'writer-frontend-stack.md': { tier: 'core', keywords: ['WDS Storybook', 'TanStack Query'], refs: ['fe-web-app-stack-migration.md'] },
  'writer-managed-mac-constraints.md': { tier: 'context', keywords: ['managed Mac'], refs: [] },
  'writer-mcp-backend-design.md': { tier: 'core', keywords: ['MCP backend design'], refs: ['writer-connectors-permission-model.md'] },
  'writer-monorepo-local-fullstack-worktrees.md': { tier: 'context', keywords: ['scripts/worktree.py', 'local-connector-stack'], refs: [] },
  'writer-observability-tooling.md': { tier: 'context', keywords: ['Langfuse', 'OpenTelemetry emission'], refs: [] },
  'writer-onboarding-resource-map.md': { tier: 'context', keywords: ['Writer onboarding map'], refs: ['writer-connectors-team.md'] },
  'writer-product-surfaces.md': { tier: 'context', keywords: ['skynet deployments', 'Agent Studio'], refs: [] },
  'writer-repo-and-environment-map.md': { tier: 'core', keywords: ['five connector repos', 'prod org 3002'], refs: ['writer-be-mcp-gateway-local-setup.md', 'writer-fe-web-app-local-setup.md'] },
  'writer-tooling-and-process.md': { tier: 'core', keywords: ['CON-194 split', 'pre-push hook'], refs: ['writer-branching-and-deploy.md'] },
};
const numberedHeading = /^#{2,3} <a id="(\d+)"><\/a>\1\. (.*)$/gm;
const unnumberedHeading = /^#{2,3} (?!<a id="\d+"><\/a>\d+\. ).+$/gm;
const citation = /\[([\w.-]+\.md)#(\d+)\]/g;
const errors: string[] = [];

async function collect(directory: string) {
  const entries = new Map<string, Entry[]>();
  const sources = new Map<string, string>();
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.md') && name !== 'index.md').sort()) {
    const source = await readFile(join(directory, file), 'utf8');
    sources.set(file, source);
    const numbered = [...source.matchAll(numberedHeading)].map((match) => ({ id: Number(match[1]), title: match[2] }));
    if (source.match(unnumberedHeading)) errors.push(`${file} has an unnumbered entry heading.`);
    if (new Set(numbered.map(({ id }) => id)).size !== numbered.length) errors.push(`${file} has duplicate entry IDs.`);
    entries.set(file, numbered);
  }
  return { entries, sources };
}

function render(title: string, entries: Map<string, Entry[]>) {
  const rows = [...entries.keys()].map((file) => {
    const item = metadata[file];
    if (!item) { errors.push(`${file} has no catalogue metadata.`); return ''; }
    const refs = item.refs.length ? item.refs.map((ref) => `\`${ref}\``).join(', ') : '—';
    return `| \`${file}\` | ${entries.get(file)?.length ?? 0} | ${item.tier} | ${item.keywords.join('; ')} | ${refs} |`;
  });
  return `# ${title} catalogue\n\nRead these rows first, then open only matching files. Entry counts are generated from numbered headings by \`npm run memory:catalogue\`; never edit them by hand.\n\n| Path | Entries | Tier | Keywords (owned here) | Cross-refs |\n| --- | ---: | --- | --- | --- |\n${rows.join('\n')}\n`;
}

const [shared, knowledge] = await Promise.all([collect(sharedDirectory), collect(knowledgeDirectory)]);
const allEntries = new Map([...shared.entries, ...knowledge.entries]);
for (const [file, source] of [...shared.sources, ...knowledge.sources]) for (const match of source.matchAll(citation)) {
  if (!allEntries.get(match[1])?.some(({ id }) => id === Number(match[2]))) errors.push(`${file} has dangling citation [${match[1]}#${match[2]}].`);
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
