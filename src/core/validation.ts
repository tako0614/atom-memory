import type { AtomContent, AtomRevision, Origin, Ref, ProposedRevision } from '../contracts.js';
import type { Principal } from './authority.js';
import { canonical, digest, fail, validId } from './util.js';
export interface Limits {
  maxBatch: number;
  maxAtomBytes: number;
  maxSlots: number;
  maxOrigins: number;
  maxWriteBytes: number;
  maxReadCandidates: number;
}
export const defaultLimits: Limits = {
  maxBatch: 256,
  maxAtomBytes: 65536,
  maxSlots: 128,
  maxOrigins: 128,
  maxWriteBytes: 2097152,
  maxReadCandidates: 10000,
};
export function validateRef(ref: Ref): void {
  if (!ref || !['pinned', 'logical'].includes(ref.kind)) fail('INVALID_SCHEMA');
  validId(ref.atomId);
  if (ref.kind === 'pinned') validId(ref.revisionId);
}
export function validateContent(
  c: AtomContent,
  principal: Principal,
  limits: Limits,
  hostDerived: boolean,
): void {
  if (!c || typeof c !== 'object') fail('INVALID_SCHEMA');
  validId(c.schema);
  validId(c.policyId);
  if (!principal.writePolicies.includes(c.policyId)) fail('ACCESS_DENIED');
  if (
    !['active', 'retired'].includes(c.state) ||
    !Array.isArray(c.slots) ||
    !Array.isArray(c.origins)
  )
    fail('INVALID_SCHEMA');
  if (
    c.slots.length > limits.maxSlots ||
    c.origins.length > limits.maxOrigins ||
    Buffer.byteLength(canonical(c)) > limits.maxAtomBytes
  )
    fail('LIMIT_EXCEEDED');
  if (
    !c.provenance ||
    !['source', 'extraction', 'organization', 'derived', 'hypothesis'].includes(c.provenance.kind)
  )
    fail('INVALID_SCHEMA');
  validId(c.provenance.producerId);
  if ((c.schema === 'source') !== (c.provenance.kind === 'source'))
    fail('INVALID_SCHEMA', 'Source schema and trusted provenance must agree');
  if (c.provenance.kind === 'source' && (!principal.canIngestSource || hostDerived))
    fail('ACCESS_DENIED', 'Only trusted ingestion may label source data');
  if (['extraction', 'derived'].includes(c.provenance.kind) && !c.provenance.inputReceiptId)
    fail('INVALID_SCHEMA', 'Derived content requires a host read receipt');
  if (!c.body || !['inline', 'blob'].includes(c.body.kind)) fail('INVALID_SCHEMA');
  if (c.body.kind === 'inline') canonical(c.body.value);
  else {
    validId(c.body.blobId);
    validId(c.body.mediaType);
    if (
      !/^[a-f0-9]{64}$/.test(c.body.digest) ||
      !Number.isSafeInteger(c.body.bytes) ||
      c.body.bytes < 0
    )
      fail('INVALID_SCHEMA');
  }
  for (const slot of c.slots) {
    validId(slot.role);
    validateRef(slot.target);
    if (!['include', 'refer'].includes(slot.mode)) fail('INVALID_SCHEMA');
    if (slot.mode === 'include' && slot.target.kind !== 'pinned') fail('PINNED_INCLUDE_REQUIRED');
    if (slot.orderKey !== undefined) validId(slot.orderKey);
  }
  if (c.validTime) {
    if (!['known', 'partial', 'unknown'].includes(c.validTime.status)) fail('INVALID_SCHEMA');
    for (const time of [c.validTime.from, c.validTime.until])
      if (time !== undefined && !Number.isFinite(Date.parse(time))) fail('INVALID_SCHEMA');
    if (
      c.validTime.from &&
      c.validTime.until &&
      Date.parse(c.validTime.from) >= Date.parse(c.validTime.until)
    )
      fail('INVALID_SCHEMA');
  }
}
export function validateOrigin(
  origin: Origin,
  source: AtomRevision,
  readBlob: (id: string) => Uint8Array | undefined,
): void {
  validateRef(origin.source);
  const span = origin.selector;
  if (
    origin.source.kind !== 'pinned' ||
    source.provenance.kind !== 'source' ||
    span?.kind !== 'utf8'
  )
    fail('INVALID_SOURCE_SPAN');
  let bytes: Uint8Array;
  if (source.body.kind === 'inline' && typeof source.body.value === 'string')
    bytes = Buffer.from(source.body.value);
  else if (source.body.kind === 'blob')
    bytes = readBlob(source.body.blobId) ?? fail('REFERENCE_UNAVAILABLE');
  else return fail('INVALID_SOURCE_SPAN', 'Source coordinates require UTF-8 text');
  const { start, end } = span;
  const boundary = (n: number) => n === bytes.length || ((bytes[n] ?? 128) & 0xc0) !== 0x80;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > bytes.length ||
    !boundary(start) ||
    !boundary(end)
  )
    fail('INVALID_SOURCE_SPAN');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('INVALID_SOURCE_SPAN');
  }
  if (digest(bytes.subarray(start, end)) !== span.quoteDigest)
    fail('INVALID_SOURCE_SPAN', 'Quote digest mismatch');
}
export function validateBatchDag(proposals: readonly ProposedRevision[]): void {
  const byRevision = new Map(proposals.map((p) => [p.revisionId, p]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail('INCLUDE_CYCLE');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const slot of byRevision.get(id)?.content.slots ?? [])
      if (slot.mode === 'include' && byRevision.has(slot.target.revisionId))
        visit(slot.target.revisionId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byRevision.keys()) visit(id);
}
