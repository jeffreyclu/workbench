import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Repositories this Workbench can review: the checkouts sitting alongside its
 * own. Shared so that a review created from the repository picker offers
 * exactly the checkouts Repo Explorer already offers a conversation, rather
 * than a second, differently-derived list.
 */
export function listCandidateWorkspaces(): string[] {
  const root = dirname(process.cwd());
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((path) => existsSync(join(path, '.git')) || existsSync(join(path, 'package.json')))
    .map((path) => resolve(path));
}
