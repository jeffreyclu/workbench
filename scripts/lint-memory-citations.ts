import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const memoryDirectories = [
  join(process.cwd(), 'docs/shared-memory'),
  join(homedir(), 'Documents/Workbench/notes/knowledge'),
];
const numberedHeading = /^#{2,3} <a id="(\d+)"><\/a>\1\. (.*)$/gm;
const unnumberedHeading = /^#{2,3} (?!<a id="\d+"><\/a>\d+\. ).+$/gm;
const citation = /\[([\w.-]+\.md)#(\d+)\]/g;
const movedEntry = /^MOVED -> ([\w.-]+\.md)#(\d+)$/;

type Entry = { id: number; title: string };
const entriesByFile = new Map<string, Entry[]>();
const errors: string[] = [];

for (const directory of memoryDirectories) {
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.md') && name !== 'index.md')) {
    const path = join(directory, file);
    const source = await readFile(path, 'utf8');
    const entries: Entry[] = [];
    for (const match of source.matchAll(numberedHeading)) {
      entries.push({ id: Number(match[1]), title: match[2] });
    }
    if (source.match(unnumberedHeading)) errors.push(`${file} has an unnumbered entry heading.`);
    const duplicateIds = entries.filter((entry, index) => entries.findIndex(({ id }) => id === entry.id) !== index);
    for (const entry of duplicateIds) errors.push(`${file} has duplicate entry #${entry.id}.`);
    entriesByFile.set(file, entries);
  }
}

for (const directory of memoryDirectories) {
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.md') && name !== 'index.md')) {
    const source = await readFile(join(directory, file), 'utf8');
    for (const match of source.matchAll(citation)) {
      const [, targetFile, targetId] = match;
      if (!entriesByFile.get(targetFile)?.some(({ id }) => id === Number(targetId))) {
        errors.push(`${file} has dangling citation [${targetFile}#${targetId}].`);
      }
    }
    for (const entry of entriesByFile.get(file) ?? []) {
      const moved = entry.title.match(movedEntry);
      if (moved && !entriesByFile.get(moved[1])?.some(({ id }) => id === Number(moved[2]))) {
        errors.push(`${file} tombstone #${entry.id} has unresolved target ${moved[1]}#${moved[2]}.`);
      }
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Memory citations are valid across ${entriesByFile.size} files.`);
}
