import 'dotenv/config';
import { openDatabase } from './database.js';
import { collectMemoryDocuments, indexPendingMemory, pruneLegacyAuditMemory } from './memory-index.js';

const database = openDatabase();
try {
  await pruneLegacyAuditMemory(database);
  collectMemoryDocuments(database);
  for (;;) {
    const result = await indexPendingMemory(database, { limit: 2_000 });
    if (!result.documents) break;
  }
} finally {
  database.close();
}
