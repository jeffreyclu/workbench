import 'dotenv/config';
import { openDatabase } from '../src/server/database.js';
import { collectMemoryDocuments, indexPendingMemory } from '../src/server/memory-index.js';

// One-shot backfill for the vectorized memory index: collects every durable
// record (messages, activity, runs, audit log, work items, docs/**/*.md) into
// memory_documents, then chunks and embeds whatever is new or changed. Safe
// to run repeatedly -- both stages are upserts keyed on content, so a repeat
// run with no new durable records is a no-op. The server also runs this pair
// on every startup (see src/server/index.ts); this script exists for a
// standalone backfill without starting the API.
const database = openDatabase();
const { upserted } = collectMemoryDocuments(database);
console.log(`Collected ${upserted} new or changed memory document(s).`);

let totalDocuments = 0;
let totalChunks = 0;
for (;;) {
  const { documents, chunks } = await indexPendingMemory(database, { limit: 2_000 });
  if (!documents) break;
  totalDocuments += documents;
  totalChunks += chunks;
}
console.log(`Indexed ${totalDocuments} document(s) into ${totalChunks} chunk(s).`);
database.close();
