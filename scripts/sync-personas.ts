import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadPersonaFiles, renderClaudeAgent } from '../src/server/personas.js';

// Regenerates ~/.claude/agents/*.md from docs/personas/*.md. With --check, writes nothing and exits 1 on drift.
const check = process.argv.includes('--check');
const target = process.env.CLAUDE_AGENTS_DIR ?? join(homedir(), '.claude', 'agents');
const drifted: string[] = [];

if (!check) mkdirSync(target, { recursive: true });
for (const persona of loadPersonaFiles()) {
  const path = join(target, `${persona.name}.md`);
  const expected = renderClaudeAgent(persona);
  let actual: string | null = null;
  try { actual = readFileSync(path, 'utf8'); } catch { /* missing counts as drift */ }
  if (actual === expected) continue;
  drifted.push(persona.name);
  if (!check) writeFileSync(path, expected);
}

if (check) {
  if (drifted.length) {
    console.error(`Persona drift in ${target}: ${drifted.join(', ')}. Run "npm run personas:sync".`);
    process.exit(1);
  }
  console.log(`${target} matches docs/personas.`);
} else {
  console.log(drifted.length ? `Regenerated ${drifted.length} persona file(s) in ${target}: ${drifted.join(', ')}` : `${target} already matches docs/personas.`);
}
