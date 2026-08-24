import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../src/server/database.js';
import { lifecycleCsv, lifecycleExportEvents, lifecycleXes } from '../src/server/process-mining.js';

const outputDirectory = resolve(process.argv[2] ?? 'process-mining/output');
const database = openDatabase(process.env.DATABASE_PATH);
try {
  const events = lifecycleExportEvents(database);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, 'lifecycle.csv'), lifecycleCsv(events));
  writeFileSync(resolve(outputDirectory, 'lifecycle.xes'), lifecycleXes(events));
  process.stdout.write(`Exported ${events.length} lifecycle events to ${outputDirectory}\n`);
} finally {
  database.close();
}
