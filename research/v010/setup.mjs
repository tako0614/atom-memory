import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryHost, MemoryStorage, LocalAuthority, utf8Tokenizer } from '../../dist/index.js';
import { SqliteStorage } from '../../dist/adapters/sqlite.js';
import { sourceManifest } from '../../dist/client/observation.js';

export const ampleBudget = {
  maxModelCalls: 1024,
  maxCandidates: 20000,
  maxBytes: 32000000,
  maxAtoms: 256,
  maxContextTokens: 1000000,
  maxEvaluationWork: 20000000,
  maxPackingWork: 20000000,
  maxModelInputTokens: 1000000,
};

/** Fixture preparation is outside retrieval. Each variant receives identical immutable rows. */
export async function prepareFixture(fixture) {
  const started = performance.now();
  const storage = new MemoryStorage();
  const authority = new LocalAuthority();
  const auth = authority.issue({
    subject: 'v010-fixture',
    readPolicies: ['p'],
    writePolicies: ['p'],
    canIngestSource: true,
  });
  const binding = { auth, writePolicy: 'p', actor: { type: 'human' } };
  const pins = new Map(
    fixture.nodes.map((node) => [
      node.id,
      { kind: 'pinned', atomId: node.id, revisionId: `v010-${node.id}` },
    ]),
  );
  const vectors = new Map(fixture.nodes.map((node) => [node.text, node.vector]));
  const embedding = {
    id: 'v010-fixed-4d',
    dimensions: 4,
    networkCallsPerCall: 0,
    tokenizer: utf8Tokenizer,
    async embed(texts, _signal, purpose) {
      return texts.map((text) => {
        const vector = purpose === 'document' ? vectors.get(text) : fixture.contextVector;
        if (!vector) throw new Error(`Unknown fixture document: ${text.slice(0, 80)}`);
        return vector;
      });
    },
  };
  const candidateProvider = {
    id: 'v010-fixed-ingress',
    async retrieve({ ledger, after, maxScan }) {
      const ids = after ? [] : fixture.seeds.slice(0, maxScan);
      ledger.charge({ maxCandidates: ids.length });
      return {
        candidates: ids.map((id) => pins.get(id)),
        scanned: ids.length,
        complete: ids.length === fixture.seeds.length,
        pending: false,
        approximate: true,
      };
    },
  };
  const options = {
    authority,
    embedding,
    candidateProvider,
    cacheMaxEntries: 0,
    activation: { relations: fixture.relations ?? {} },
    retrieval: {
      maxSeeds: fixture.seeds.length,
      maxNodes: fixture.maxNodes ?? 256,
      maxEdges: fixture.maxEdges ?? 2048,
      depth: fixture.depth,
    },
  };
  const host = new MemoryHost({ ...options, storage });
  const engine = host.engine;
  const session = engine.session(binding, { budget: ampleBudget });
  const trace = { ...session.trace, id: `v010-source-${fixture.id}` };
  engine.bridge(trace, binding, true);
  sourceManifest(engine, trace.id, [], 'p');
  // The kernel validates the same source-v2 content contract as a public human
  // write. Explicit fixture IDs make inverse posting order reproducible.
  await engine.kernel.write(
    {
      idempotencyKey: `v010-create-${fixture.id}`,
      guards: [],
      revisions: fixture.nodes.map((node) => ({
        ...pins.get(node.id),
        expectedHead: null,
        content: {
          schema: 'source',
          state: 'active',
          policyId: 'p',
          body: { kind: 'inline', value: node.text },
          origins: [],
          slots: (node.links ?? []).map((link, index) => ({
            role: link.role,
            mode: 'refer',
            target: { kind: 'logical', atomId: link.to },
            ...(link.required ? { required: true } : {}),
            orderKey: String(index).padStart(4, '0'),
          })),
          provenance: {
            kind: 'source',
            producerId: 'v010-fixture',
            dependencyContract: 'source-v2',
            inputReceiptId: trace.id,
          },
        },
      })),
    },
    auth,
  );
  const indexStarted = performance.now();
  await host.prepareIndex(binding, { budget: ampleBudget });
  const indexMs = performance.now() - indexStarted;
  const refSession = engine.session(binding, { budget: ampleBudget });
  const refs = new Map(
    [...pins].map(([id, pin]) => [id, engine.issue(engine.get(pin, refSession), refSession)]),
  );
  for (const use of fixture.acceptedUses ?? [])
    for (let i = 0; i < use.count; i++)
      host.recordUse([refs.get(use.id)], binding, { eventId: `fixture-use-${use.id}-${i}` });
  const evaluatedAt = Date.now();
  const revisions = storage.history(undefined, fixture.nodes.length + 1);
  const metadata = storage.metaEntries('');
  const preparation = {
    totalMs: performance.now() - started,
    indexMs,
    metadataBytes: Buffer.byteLength(JSON.stringify(metadata)),
    corpusBytes: Buffer.byteLength(JSON.stringify(revisions)),
    atoms: revisions.length,
  };
  storage.close();
  return {
    fixture,
    binding,
    refs,
    pins,
    evaluatedAt,
    preparation,
    makeVariant(adapter = 'memory', overrides = {}) {
      const dir = adapter === 'sqlite' ? mkdtempSync(join(tmpdir(), 'atom-v010-')) : undefined;
      const store = dir ? new SqliteStorage(join(dir, 'fixture.sqlite')) : new MemoryStorage();
      store.transaction(() => {
        store.append(revisions);
        for (const [key, value] of metadata) store.metaSet(key, value);
      });
      const variant = new MemoryHost({ ...options, storage: store, ...overrides });
      return {
        host: variant,
        engine: variant.engine,
        binding,
        storage: store,
        refs,
        pins,
        close() {
          store.close();
          if (dir) rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  };
}

export function fixtureId(ref, storage) {
  return storage.metaGet(`sdk:ref:${ref}`)?.target.atomId;
}
