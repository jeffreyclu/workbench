import type { Embedder } from './memory-index.js';

/**
 * Deterministic, dependency-free stand-in for the real transformers.js
 * embedder (see `setEmbedder` in memory-index.ts). Tests must never trigger a
 * model download or a real inference pass, but still need vectors that are
 * stable across calls and roughly reflect textual similarity: identical or
 * near-identical text should score higher against itself than unrelated text
 * does. A normalized bag-of-characters hash gives both properties cheaply.
 */
const TEST_EMBEDDING_DIMS = 32;

export const deterministicTestEmbedder: Embedder = async (texts: string[]) => texts.map((text) => {
  const vector = new Float32Array(TEST_EMBEDDING_DIMS);
  const normalized = text.toLowerCase();
  for (let index = 0; index < normalized.length; index += 1) {
    vector[normalized.charCodeAt(index) % TEST_EMBEDDING_DIMS] += 1;
  }
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) norm += vector[index] * vector[index];
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
});
