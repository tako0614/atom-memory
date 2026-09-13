// Optional local CPU inference; installs no dependency into Atom Memory.
// ATOM_TRANSFORMERS_MODULE may point at an externally installed module entry.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { texts } from './semantic-corpus.mjs';
const { pipeline, env } = await import(
  process.env.ATOM_TRANSFORMERS_MODULE ?? '@huggingface/transformers'
);
const model = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const revision = process.env.ATOM_MODEL_REVISION ?? '2c4055b12046f11709e9df2c122e59ffbdc2f900';
if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Expected a pinned model revision');
env.cacheDir =
  process.env.ATOM_MODEL_CACHE ?? join(homedir(), '.cache', 'atom-memory-composition', 'models');
const start = performance.now();
const extractor = await pipeline('feature-extraction', model, {
  revision,
  dtype: 'q8',
  device: 'cpu',
  session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
});
const ready = performance.now(),
  input = texts(),
  vectors = {};
for (let i = 0; i < input.length; i += 8) {
  const batch = input.slice(i, i + 8);
  const output = await extractor(batch, { pooling: 'mean', normalize: true });
  const rows = output.tolist();
  batch.forEach((text, j) => {
    vectors[text] = rows[j];
  });
}
const record = {
  at: new Date().toISOString(),
  model,
  revision,
  runtime: '@huggingface/transformers@3.8.1',
  dtype: 'q8',
  pooling: 'mean',
  normalize: true,
  device: 'cpu',
  threads: 2,
  loadAndDownloadMs: ready - start,
  embeddingMs: performance.now() - ready,
  inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  dimensions: Object.values(vectors)[0].length,
  vectors,
};
writeFileSync(
  new URL('semantic-vectors.json.gz', import.meta.url),
  gzipSync(JSON.stringify(record) + '\n'),
);
await extractor.dispose();
console.log(JSON.stringify({ ...record, vectors: Object.keys(vectors).length }));
