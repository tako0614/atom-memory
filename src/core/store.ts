import type {
  AtomRevision,
  AuthContext,
  PinnedRef,
  ProposedRevision,
  Ref,
  WriteRequest,
  WriteResult,
} from '../contracts.js';
import type { Authorizer, Principal } from './authority.js';
import type { StorageAdapter, ScanQuery } from '../adapters/storage.js';
import { MemoryStorage } from '../adapters/memory.js';
import { canonical, clone, digest, fail, uid, validId } from './util.js';
import {
  defaultLimits,
  validateBatchDag,
  validateContent,
  validateOrigin,
  type Limits,
} from './validation.js';
import { purgeStorage } from './purge.js';

export interface ReceiptManifest {
  contractVersion?: 2;
  dependencyContract?: 'legacy' | 'source' | 'observed';
  authorityGeneration?: string;
  receipt: { receiptId: string };
  subject: string;
  authBinding: string;
  generation?:
    | string
    | {
        id: string;
        scope: string;
        payloadDigest: string;
        presentations: { receiptId: string; digest: string; units: PresentationUnit[] }[];
        sources: import('../contracts.js').Origin[];
        inherited: string[];
        inheritedOutputs?: PinnedRef[];
        historicalReads?: PinnedRef[];
        outputs: PinnedRef[];
      };
  acquisition?: {
    reads: PinnedRef[];
    ranges: AcquiredRange[];
    observations: ReceiptManifest['observations'];
    index: number;
  };
  presentation?: { formatVersion: 2; digest: string; units: PresentationUnit[] };
  watches?: { reads: PinnedRef[]; observations: ReceiptManifest['observations'] };
  acknowledgement?: { eventId: string; acceptedAt: number; revisions: PinnedRef[] }[];
  policies: string[];
  /** Observed storage position for audit; not a retained-snapshot token. */
  watermark: number;
  reads: PinnedRef[];
  /** Optional explicit currentness preconditions, distinct from the complete audit. */
  currentReads?: PinnedRef[];
  /** The SDK commits these outputs as one dependency unit; prevents artificial intra-batch cycles. */
  ownedRevisionIds?: string[];
  historicalInputs?: boolean;
  observations: {
    observationId: string;
    watermark: number;
    query: ScanQuery;
    revisionIds: string[];
  }[];
  expiresAt: number;
}
export interface AcquiredRange {
  revision: PinnedRef;
  start: number;
  end: number;
  unit: 'utf8' | 'byte';
  digest: string;
}
export interface PresentationUnit {
  ref: import('../client/types.js').AtomRef;
  revision: PinnedRef;
  digest: string;
  metadata?: Omit<import('../client/types.js').AtomView, 'text' | 'ref'> & {
    /** Present only for inspect neighbors; relation evidence is part of the presentation. */
    via?: readonly import('../client/types.js').InspectionVia[];
    inspectionRoot?: boolean;
  };
  display?: 'body' | 'quote' | 'range';
  quote?: { ref: import('../client/types.js').AtomRef; start: number; end: number; unit: 'utf8' };
  range?: { start: number; end: number };
}
export const manifestAuthorityGeneration = (m: ReceiptManifest): string | undefined =>
  m.authorityGeneration ?? (typeof m.generation === 'string' ? m.generation : undefined);
interface BlobRecord {
  bytes: string;
  policyId: string;
  digest: string;
  mediaType: string;
}
export interface StoreOptions {
  storage?: StorageAdapter;
  authority: Authorizer;
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
  readonly limits: Limits;
  constructor(options: StoreOptions) {
    this.storage = options.storage ?? new MemoryStorage();
    this.authority = options.authority;
    this.limits = { ...defaultLimits, ...options.limits };
  }
  #principal(auth: AuthContext): Principal {
    return this.authority.resolve(auth);
  }
  #manifest(id: string, auth: AuthContext, p: Principal): ReceiptManifest {
    const m = this.storage.metaGet<ReceiptManifest>(`receipt:${id}`);
    if (!m || Date.now() > m.expiresAt) fail('CURSOR_EXPIRED');
    if (
      m.authBinding !== authBinding(auth) ||
      m.subject !== p.subject ||
      manifestAuthorityGeneration(m) !== p.generation ||
      m.policies.some((id) => !p.readPolicies.includes(id))
    )
      fail('ACCESS_DENIED');
    if (m.reads.some((r) => this.storage.isPurged(r.atomId))) fail('ACCESS_DENIED');
    return m;
  }
  #currentDependency(
    m: ReceiptManifest,
    at: number,
    proposals: readonly ProposedRevision[],
  ): boolean {
    if (
      m.dependencyContract === 'observed' &&
      (m.currentReads ?? []).some((ref) =>
        proposals.some(
          (proposal) =>
            proposal.atomId === ref.atomId &&
            proposal.revisionId !== ref.revisionId &&
            proposal.content.provenance.inputReceiptId !== m.receipt.receiptId,
        ),
      )
    )
      return false;
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
        proposals.some((r) => r.atomId === ref.atomId && r.revisionId === ref.revisionId),
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
    if (this.storage.metaGet('purge:pending')) fail('ACCESS_DENIED', 'Erasure is incomplete');
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
        const current = this.#currentDependency(manifest, at, input.revisions);
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
        if (
          c.provenance.dependencyContract === 'observed-v2' &&
          (receipt?.contractVersion !== 2 ||
            receipt.dependencyContract !== 'observed' ||
            !receipt.generation ||
            typeof receipt.generation === 'string')
        )
          fail('ACCESS_DENIED', 'Observed derivation requires a host input token');
        if (
          c.provenance.dependencyContract === 'source-v2' &&
          (c.provenance.kind !== 'source' ||
            !p.canIngestSource ||
            receipt?.dependencyContract !== 'source')
        )
          fail('ACCESS_DENIED');
        if (actor && receiptId !== actor.receipt.receiptId)
          fail('ACCESS_DENIED', 'All Writer changes must retain the host input receipt');
        if (receipt && receipt.policies.some((id) => id !== c.policyId))
          fail('ACCESS_DENIED', 'Persistent derivation cannot cross policies');
        if (receipt && !currentDependency(receipt)) fail('REVISION_CONFLICT');
        const previous = item.expectedHead
          ? this.storage.get(
              { kind: 'pinned', atomId: item.atomId, revisionId: item.expectedHead },
              at,
            )
          : undefined;
        // Retiring an authorized unchanged body must preserve even unavailable
        // references. This cannot introduce a hidden target or alter its content.
        const unchangedRetirement =
          c.state === 'retired' &&
          previous &&
          canonical([c.body, c.slots, c.origins]) ===
            canonical([previous.body, previous.slots, previous.origins]);
        for (const slot of unchangedRetirement ? [] : c.slots) {
          const target = resolve(slot.target);
          if (target.policyId !== c.policyId && !c.provenance.dependencyContract)
            fail('ACCESS_DENIED', 'Persistent references must remain in one policy');
        }
        for (const origin of unchangedRetirement ? [] : c.origins) {
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
          if (!this.#currentDependency(manifest, at, []))
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
    if (this.storage.metaGet('purge:pending')) fail('ACCESS_DENIED', 'Erasure is incomplete');
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
  purge(atomId: string, options: import('./purge.js').PurgeOptions = {}) {
    return purgeStorage(this.storage, atomId, options);
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
