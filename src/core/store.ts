import type {
  AtomRevision,
  AuthContext,
  PinnedRef,
  ProposedRevision,
  ReadReceipt,
  Ref,
  Selector,
  WriteRequest,
  WriteResult,
} from '../contracts.js';
import type { Authorizer, Principal } from './authority.js';
import type { StorageAdapter, ScanQuery } from '../adapters/storage.js';
import { MemoryStorage } from '../adapters/memory.js';
import { utf8Tokenizer, type Tokenizer } from './budget.js';
import { canonical, clone, digest, fail, uid, validId } from './util.js';
import {
  defaultLimits,
  validateBatchDag,
  validateContent,
  validateOrigin,
  validateRef,
  type Limits,
} from './validation.js';

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  readonly tokenizer: Tokenizer;
  readonly networkCallsPerCall: number;
  embed(
    texts: readonly string[],
    signal: AbortSignal,
    purpose?: 'query' | 'document',
  ): Promise<readonly (readonly number[])[]>;
}
export interface ReceiptManifest {
  receipt: ReadReceipt;
  subject: string;
  authBinding: string;
  generation: string;
  policies: string[];
  watermark: number;
  reads: PinnedRef[];
  /** Optional explicit currentness preconditions, distinct from the complete audit. */
  currentReads?: PinnedRef[];
  /** The SDK commits these outputs as one dependency unit; prevents artificial intra-batch cycles. */
  ownedRevisionIds?: string[];
  historicalInputs?: boolean;
  observations: {
    observationId: string;
    selector: Selector;
    watermark: number;
    query: ScanQuery;
    revisionIds: string[];
  }[];
  expiresAt: number;
  tokenizerId: string;
  encoderConfigId?: string;
  indexWatermark?: number;
  overlayHandle?: string;
}
interface Overlay {
  authBinding: string;
  watermark: number;
  revisions: readonly ProposedRevision[];
}
interface BlobRecord {
  bytes: string;
  policyId: string;
  digest: string;
  mediaType: string;
}
export interface StoreOptions {
  storage?: StorageAdapter;
  authority: Authorizer;
  tokenizer?: Tokenizer;
  embedding?: EmbeddingProvider;
  limits?: Partial<Limits>;
}
const pinned = (r: AtomRevision): PinnedRef => ({
  kind: 'pinned',
  atomId: r.atomId,
  revisionId: r.revisionId,
});
const authBinding = (auth: AuthContext) => digest(auth.authorizationHandle);

/** Trusted host service. Expose only read/write through bound model tools. */
export class AtomicStore {
  readonly storage: StorageAdapter;
  readonly authority: Authorizer;
  readonly tokenizer: Tokenizer;
  readonly limits: Limits;
  readonly embedding?: EmbeddingProvider;
  constructor(options: StoreOptions) {
    this.storage = options.storage ?? new MemoryStorage();
    this.authority = options.authority;
    this.tokenizer = options.tokenizer ?? utf8Tokenizer;
    this.embedding = options.embedding;
    this.limits = { ...defaultLimits, ...options.limits };
  }
  #principal(auth: AuthContext): Principal {
    return this.authority.resolve(auth);
  }
  #manifest(id: string, auth: AuthContext, p: Principal, allowExpired = false): ReceiptManifest {
    const m = this.storage.metaGet<ReceiptManifest>(`receipt:${id}`);
    if (!m || (!allowExpired && Date.now() > m.expiresAt)) fail('CURSOR_EXPIRED');
    if (
      m.authBinding !== authBinding(auth) ||
      m.subject !== p.subject ||
      m.generation !== p.generation ||
      m.policies.some((id) => !p.readPolicies.includes(id))
    )
      fail('ACCESS_DENIED');
    if (m.reads.some((r) => this.storage.isPurged(r.atomId))) fail('ACCESS_DENIED');
    return m;
  }
  #currentDependency(m: ReceiptManifest, at: number, overlay?: Overlay): boolean {
    if (
      m.observations.some(
        (o) =>
          canonical(
            this.storage
              .scan({ ...o.query, limit: Math.min(o.query.limit, o.revisionIds.length + 1) }, at)
              .map((r) => r.revisionId),
          ) !== canonical(o.revisionIds),
      )
    )
      return false;
    return (m.currentReads ?? m.reads).every(
      (ref) =>
        this.storage.get({ kind: 'logical', atomId: ref.atomId }, at)?.revisionId ===
          ref.revisionId ||
        overlay?.revisions.some((r) => r.atomId === ref.atomId && r.revisionId === ref.revisionId),
    );
  }
  #blob(id: string): BlobRecord | undefined {
    return this.storage.metaGet<BlobRecord>(`blob:${id}`);
  }
  async write(
    request: WriteRequest,
    auth: AuthContext,
    hooks?: { validate?(): void; committed?(result: WriteResult): void },
  ): Promise<WriteResult> {
    const input = clone(request);
    const p = this.#principal(auth);
    if (!this.storage.capabilities.atomicBatch) fail('ATOMICITY_UNAVAILABLE');
    if (!input || !Array.isArray(input.revisions) || !Array.isArray(input.guards))
      fail('INVALID_SCHEMA');
    validId(input.idempotencyKey);
    if (
      !input.revisions.length ||
      input.revisions.length > this.limits.maxBatch ||
      input.guards.length > this.limits.maxBatch ||
      Buffer.byteLength(canonical(input)) > this.limits.maxWriteBytes
    )
      fail('LIMIT_EXCEEDED');
    if (
      input.guards.some((g) => g.kind === 'query-observation') &&
      !this.storage.capabilities.queryGuards
    )
      fail('GUARD_VALIDATION_UNAVAILABLE');
    const key = `write:${digest(canonical([p.subject, input.idempotencyKey]))}`;
    const fingerprint = digest(canonical(input));
    return this.storage.transaction(() => {
      const previous = this.storage.metaGet<{
        fingerprint: string;
        result: WriteResult;
        policies: string[];
      }>(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
        if (
          previous.policies.some((id) => !p.writePolicies.includes(id)) ||
          previous.result.committed.some((r) => this.storage.isPurged(r.atomId))
        )
          fail('ACCESS_DENIED');
        return { ...previous.result, repeatedInput: true };
      }
      hooks?.validate?.();
      const at = this.storage.watermark();
      const manifests = new Map<string, ReceiptManifest>();
      const manifestFor = (id: string): ReceiptManifest => {
        const saved = manifests.get(id);
        if (saved) return saved;
        const manifest = this.#manifest(id, auth, p);
        manifests.set(id, manifest);
        return manifest;
      };
      const validated = new Set<string>();
      const currentDependency = (manifest: ReceiptManifest): boolean => {
        if (validated.has(manifest.receipt.receiptId)) return true;
        const current = this.#currentDependency(manifest, at, {
          authBinding: authBinding(auth),
          watermark: at,
          revisions: input.revisions,
        });
        if (current) validated.add(manifest.receipt.receiptId);
        return current;
      };
      const actor = input.actorInputReceiptId ? manifestFor(input.actorInputReceiptId) : undefined;
      if (actor && !currentDependency(actor))
        fail('REVISION_CONFLICT', 'Read dependencies changed');
      const ids = new Set<string>();
      const revisions = new Set<string>();
      for (const item of input.revisions) {
        validId(item.atomId);
        validId(item.revisionId);
        if (
          ids.has(item.atomId) ||
          revisions.has(item.revisionId) ||
          this.storage.metaGet(`revision-id:${item.revisionId}`)
        )
          fail('REVISION_CONFLICT');
        ids.add(item.atomId);
        revisions.add(item.revisionId);
        if (this.storage.isPurged(item.atomId)) fail('ACCESS_DENIED');
        const old = this.storage.get({ kind: 'logical', atomId: item.atomId }, at);
        if ((old?.revisionId ?? null) !== item.expectedHead) fail('REVISION_CONFLICT');
        if (
          old &&
          (old.policyId !== item.content.policyId || !p.writePolicies.includes(old.policyId))
        )
          fail('ACCESS_DENIED');
        validateContent(item.content, p, this.limits, !!actor);
      }
      const proposed = new Map(input.revisions.map((r) => [r.atomId, r]));
      const resolve = (ref: Ref): AtomRevision => {
        const next = proposed.get(ref.atomId);
        const candidate =
          next && (ref.kind === 'logical' || next.revisionId === ref.revisionId)
            ? {
                ...next.content,
                atomId: next.atomId,
                revisionId: next.revisionId,
                recordedAt: new Date().toISOString(),
              }
            : this.storage.get(ref, at);
        if (!candidate) fail('REFERENCE_UNAVAILABLE');
        if (!p.readPolicies.includes(candidate.policyId) || this.storage.isPurged(ref.atomId))
          fail('ACCESS_DENIED');
        return candidate;
      };
      for (const item of input.revisions) {
        const c = item.content;
        const receiptId = c.provenance.inputReceiptId;
        const receipt = receiptId ? manifestFor(receiptId) : undefined;
        if (actor && receiptId !== actor.receipt.receiptId)
          fail('ACCESS_DENIED', 'All Writer changes must retain the host input receipt');
        if (receipt && receipt.policies.some((id) => id !== c.policyId))
          fail('ACCESS_DENIED', 'Persistent derivation cannot cross policies');
        if (receipt && !currentDependency(receipt)) fail('REVISION_CONFLICT');
        for (const slot of c.slots) {
          const target = resolve(slot.target);
          if (target.policyId !== c.policyId)
            fail('ACCESS_DENIED', 'Persistent references must remain in one policy');
        }
        for (const origin of c.origins) {
          const source = resolve(origin.source);
          if (source.policyId !== c.policyId) fail('ACCESS_DENIED');
          if (
            receipt &&
            !receipt.reads.some(
              (r) => r.atomId === source.atomId && r.revisionId === source.revisionId,
            )
          )
            fail('ACCESS_DENIED', 'Origin was not in the host read trace');
          validateOrigin(origin, source, (id) => {
            const b = this.#blob(id);
            return b ? Buffer.from(b.bytes, 'base64') : undefined;
          });
        }
        if (c.body.kind === 'blob') {
          const b = this.#blob(c.body.blobId);
          if (
            !b ||
            b.policyId !== c.policyId ||
            b.digest !== c.body.digest ||
            b.mediaType !== c.body.mediaType ||
            Buffer.from(b.bytes, 'base64').length !== c.body.bytes
          )
            fail('REFERENCE_UNAVAILABLE');
        }
      }
      validateBatchDag(input.revisions);
      for (const guard of input.guards) {
        if (guard.kind === 'head') {
          const r = resolve({ kind: 'pinned', atomId: guard.atomId, revisionId: guard.revisionId });
          if (
            this.storage.get({ kind: 'logical', atomId: r.atomId }, at)?.revisionId !==
            guard.revisionId
          )
            fail('REVISION_CONFLICT');
        } else if (guard.kind === 'query-observation') {
          const observation = this.storage.metaGet<{ receiptId: string; watermark: number }>(
            `observation:${guard.observationId}`,
          );
          if (!observation) fail('GUARD_VALIDATION_UNAVAILABLE');
          const manifest = this.#manifest(observation.receiptId, auth, p);
          if (!this.#currentDependency(manifest, at))
            fail('REVISION_CONFLICT', 'Query range changed');
        } else fail('INVALID_SCHEMA');
      }
      this.#principal(auth);
      const committed = input.revisions.map((item) => ({
        ...cleanContent(item.content),
        provenance: { ...clone(item.content.provenance), producerId: p.subject },
        atomId: item.atomId,
        revisionId: item.revisionId,
        ...(item.expectedHead === null ? {} : { previousRevisionId: item.expectedHead }),
        recordedAt: new Date().toISOString(),
      }));
      this.storage.append(committed);
      for (const r of committed) this.storage.metaSet(`revision-id:${r.revisionId}`, true);
      const result: WriteResult = {
        operationId: uid('op'),
        committed: committed.map(pinned),
        repeatedInput: false,
        indexState: 'ready',
      };
      this.storage.metaSet(key, {
        fingerprint,
        result,
        policies: [...new Set(committed.map((r) => r.policyId))],
      });
      hooks?.committed?.(result);
      return result;
    });
  }
  /** Store large immutable source bytes through the trusted host. */
  putBlob(
    bytes: Uint8Array,
    policyId: string,
    mediaType: string,
    auth: AuthContext,
  ): { kind: 'blob'; blobId: string; digest: string; mediaType: string; bytes: number } {
    const p = this.#principal(auth);
    if (!p.canIngestSource || !p.writePolicies.includes(policyId)) fail('ACCESS_DENIED');
    validId(mediaType);
    const id = uid('blob');
    const hash = digest(bytes);
    this.storage.metaSet(`blob:${id}`, {
      bytes: Buffer.from(bytes).toString('base64'),
      policyId,
      digest: hash,
      mediaType,
    } satisfies BlobRecord);
    return { kind: 'blob', blobId: id, digest: hash, mediaType, bytes: bytes.length };
  }
  /** Deny old reads immediately, then remove transitive derivatives and private execution data. Host-only. */
  purge(atomId: string): { erasedAtomIds: string[]; physicalStorageReclaimed: false } {
    validId(atomId);
    return this.storage.transaction(() => {
      const erased = new Set([atomId]);
      const plan = this.storage.purgePlan?.(atomId);
      const receipts: [string, ReceiptManifest][] = plan
        ? plan.receiptKeys.flatMap((key) => {
            const value = this.storage.metaGet<ReceiptManifest>(key);
            return value ? [[key, value] as [string, ReceiptManifest]] : [];
          })
        : this.storage.metaEntries<ReceiptManifest>('receipt:');
      const all: AtomRevision[] = plan?.revisions ?? [];
      let after: string | undefined;
      // Purge inspects every historical revision, including retired content and old blobs.
      while (!plan) {
        const page = this.storage.history(after, 256);
        all.push(...page);
        if (page.length < 256) break;
        after = page.at(-1)!.revisionId;
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const r of all) {
          const m = receipts.find(
            ([, m]) => m.receipt.receiptId === r.provenance.inputReceiptId,
          )?.[1];
          if (
            !erased.has(r.atomId) &&
            (r.origins.some((o) => erased.has(o.source.atomId)) ||
              r.slots.some((s) => erased.has(s.target.atomId)) ||
              m?.reads.some((v) => erased.has(v.atomId)))
          ) {
            erased.add(r.atomId);
            changed = true;
          }
        }
      }
      for (const r of all)
        if (erased.has(r.atomId) && r.body.kind === 'blob')
          this.storage.metaDelete(`blob:${r.body.blobId}`);
      this.storage.erase([...erased]);
      const clear = (prefix: string) => {
        if (this.storage.metaDeletePrefix) this.storage.metaDeletePrefix(prefix);
        else for (const [key] of this.storage.metaEntries(prefix)) this.storage.metaDelete(key);
      };
      clear('cursor:');
      clear('observation:');
      for (const [key, m] of receipts)
        if (m.reads.some((r) => erased.has(r.atomId))) this.storage.metaDelete(key);
      for (const r of all)
        if (erased.has(r.atomId)) {
          this.storage.metaDelete(`embedding:${r.revisionId}`);
          this.storage.metaDelete(`sdk:index:${r.revisionId}`);
        }
      clear('sdk:cache:');
      clear('sdk:cursor:');
      this.storage.metaSet(
        'sdk:index-generation',
        (this.storage.metaGet<number>('sdk:index-generation') ?? 0) + 1,
      );
      return { erasedAtomIds: [...erased], physicalStorageReclaimed: false };
    });
  }
}

function cleanContent(
  c: import('../contracts.js').AtomContent,
): import('../contracts.js').AtomContent {
  return {
    schema: c.schema,
    state: c.state,
    body: clone(c.body),
    slots: clone(c.slots),
    origins: clone(c.origins),
    provenance: clone(c.provenance),
    policyId: c.policyId,
    ...(c.validTime ? { validTime: clone(c.validTime) } : {}),
  };
}
