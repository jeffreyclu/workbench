import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const memoryDirectories = [
  join(process.cwd(), 'docs/shared-memory'),
  join(homedir(), 'Documents/Workbench/notes/knowledge'),
];

const numberedHeading = /^(#{2,3}) <a id="(\d+)"><\/a>(\d+)\. (.*)$/;
const heading = /^(#{2,3}) (?!<a id="\d+"><\/a>\d+\. )(.*)$/;

async function markdownFiles(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((file) => file.endsWith('.md') && file !== 'index.md')
    .map((file) => join(directory, file));
}

for (const directory of memoryDirectories) {
  for (const file of await markdownFiles(directory)) {
    const source = await readFile(file, 'utf8');
    const lines = source.split('\n');
    const existingIds = lines.flatMap((line) => {
      const match = line.match(numberedHeading);
      return match ? [Number(match[2])] : [];
    });
    let nextId = Math.max(0, ...existingIds) + 1;
    let changed = false;

    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(heading);
      if (!match) continue;
      const [, level, title] = match;
      lines[index] = `${level} <a id="${nextId}"></a>${nextId}. ${title}`;
      nextId += 1;
      changed = true;
    }

    if (changed) {
      await writeFile(file, lines.join('\n'));
      console.log(`Numbered ${basename(file)}.`);
    }
  }
}
