import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One physical home for documents created or retained by Workbench. */
export const WORKBENCH_DOCUMENTS_ROOT = join(homedir(), 'Documents', 'Workbench');
export const WORKBENCH_NOTES_ROOT = join(WORKBENCH_DOCUMENTS_ROOT, 'notes');

export const WORKBENCH_DOCUMENT_DIRECTORIES = ['notes', 'artifacts', 'documents', 'imports'] as const;

/**
 * Keep the canonical tree available before memory indexing or artifact access.
 * `~/notes` remains a compatibility alias for older prompts and tools, never a
 * second physical store.
 */
export function ensureWorkbenchDocumentRoot(): void {
  mkdirSync(WORKBENCH_DOCUMENTS_ROOT, { recursive: true });
  for (const directory of WORKBENCH_DOCUMENT_DIRECTORIES) {
    mkdirSync(join(WORKBENCH_DOCUMENTS_ROOT, directory), { recursive: true });
  }
  const legacyNotes = join(homedir(), 'notes');
  if (!existsSync(legacyNotes)) symlinkSync(WORKBENCH_NOTES_ROOT, legacyNotes, 'dir');
}
