import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * docs/personas/*.md is the only place a persona is defined. The path is
 * resolved from the working directory, never from this file's location: a
 * promoted runtime runs a copy of src/ from .workbench-runtime/releases/<id>
 * with the repository as its working directory, and docs/ is not copied.
 */
export const PERSONAS_DIR = process.env.WORKBENCH_PERSONAS_DIR ?? resolve(process.cwd(), 'docs/personas');

const CLAUDE_FIELDS = ['name', 'description', 'tools', 'model'] as const;

export interface PersonaDefinition {
  name: string;
  description: string;
  tools: string;
  model: string;
  /** The prompt body, with the Claude-only frontmatter removed. */
  body: string;
}

export function parsePersona(source: string, label = 'persona'): PersonaDefinition {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`${label}: missing frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  for (const field of CLAUDE_FIELDS) if (!fields[field]) throw new Error(`${label}: frontmatter is missing "${field}"`);
  const body = match[2]!.trim();
  if (!body) throw new Error(`${label}: empty body`);
  return { name: fields.name!, description: fields.description!, tools: fields.tools!, model: fields.model!, body };
}

/** The exact file Claude Code reads from ~/.claude/agents. */
export function renderClaudeAgent(persona: PersonaDefinition): string {
  const frontmatter = CLAUDE_FIELDS.map((field) => `${field}: ${persona[field]}`).join('\n');
  return `---\n${frontmatter}\n---\n\n${persona.body}\n`;
}

export function loadPersonaFiles(directory = PERSONAS_DIR): PersonaDefinition[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const persona = parsePersona(readFileSync(join(directory, file), 'utf8'), file);
      if (`${persona.name}.md` !== file) throw new Error(`${file}: frontmatter name "${persona.name}" must match the file name`);
      return persona;
    });
}

const loaded = new Map(loadPersonaFiles().map((persona) => [persona.name, persona]));

/** The prompt text injected into a run: a header line plus the body, never the Claude frontmatter. */
export function personaPrompt(name: string, label = name): string {
  const persona = loaded.get(name);
  if (!persona) throw new Error(`Unknown persona "${name}"`);
  return `Authoritative persona: ${label}\n\n${persona.body}`;
}

export function personaBody(name: string): string {
  const persona = loaded.get(name);
  if (!persona) throw new Error(`Unknown persona "${name}"`);
  return persona.body;
}
