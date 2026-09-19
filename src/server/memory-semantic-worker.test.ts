import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { embeddingToBlob } from './memory-index.js';
import { searchSemanticChunks, shutdownMemorySemanticWorker } from './memory-semantic-worker.js';

describe('memory semantic worker', () => {
  let directory = '';
  let database: WorkbenchDatabase | null = null;

  afterEach(() => {
    shutdownMemorySemanticWorker();
    database?.close();
    database = null;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  it('exhaustively scores file-backed embeddings without blocking the caller event loop', async () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-semantic-worker-'));
    database = openDatabase(join(directory, 'workbench.db'));
    const insertDocument = database.prepare(`INSERT INTO memory_documents
      (id, source, source_id, title, body, created_at, content_hash, indexed_at)
      VALUES (?, 'message', ?, ?, ?, ?, ?, ?)`);
    const insertChunk = database.prepare(`INSERT INTO memory_chunks
      (document_id, ordinal, text, embedding, model, dims) VALUES (?, 0, ?, ?, 'test', 4)`);
    const now = '2026-09-18T12:00:00.000Z';
    database.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 2_000; index += 1) {
      const id = `document-${index}`;
      insertDocument.run(id, id, id, id, now, `hash-${index}`, now);
      const vector = index === 1_999 ? Float32Array.from([1, 0, 0, 0]) : Float32Array.from([0, 1, 0, 0]);
      insertChunk.run(id, `chunk-${index}`, embeddingToBlob(vector));
    }
    database.exec('COMMIT');

    let callerAdvanced = false;
    setImmediate(() => { callerAdvanced = true; });
    const result = await searchSemanticChunks(database, [Float32Array.from([1, 0, 0, 0])], '', [], 10, 0.35);

    expect(callerAdvanced).toBe(true);
    expect(result.primary[0]).toEqual(expect.objectContaining({ documentId: 'document-1999', similarity: 1 }));
  });
});
