import type { AtomRevision, Origin, PinnedRef } from '../contracts.js';
import type {
  AtomRef,
  AtomView,
  ClientBinding,
  HostInput,
  InputToken,
  MemoryReceipt,
} from './types.js';
import type { ReceiptManifest, PresentationUnit } from '../core/store.js';
import { manifestAuthorityGeneration } from '../core/store.js';
import { canonical, clone, digest, fail, uid } from '../core/util.js';
import { validateOrigin } from '../core/validation.js';
import { Engine, bindingKey, pinRevision, type Session } from './engine.js';

const unique = (refs: readonly PinnedRef[]) => [
  ...new Map(refs.map((r) => [r.revisionId, r])).values(),
];
const scope = (engine: Engine, binding: ClientBinding) =>
  digest(
    canonical([
      bindingKey(binding.auth),
      binding.writePolicy,
      [...engine.policies(binding, engine.principal(binding))].sort(),
      binding.actor,
    ]),
  );

/** Trusted-host audit read. Raw pinned identities never replace authorization. */
export function manifest(
  engine: Engine,
  value: MemoryReceipt | InputToken,
  binding: ClientBinding,
): ReceiptManifest {
  const id = typeof value === 'string' ? value : value?.id;
  if (typeof id !== 'string') fail('INVALID_INPUT');
  const m =
    engine.storage.metaGet<ReceiptManifest>(`receipt:${id}`) ??
    engine.storage.metaGet<ReceiptManifest>(`sdk:manifest:${id}`);
  if (!m) fail('INVALID_INPUT', 'Observation was not issued by this host');
  const s = engine.session(binding);
  if (Date.now() > m.expiresAt) fail('CURSOR_EXPIRED');
  if (
    m.authBinding !== bindingKey(binding.auth) ||
    m.subject !== s.principal.subject ||
    manifestAuthorityGeneration(m) !== s.principal.generation ||
    m.policies.some((p) => !s.trace.policies.includes(p))
  )
    fail('ACCESS_DENIED');
  if (
    typeof value === 'string' &&
    (!m.generation ||
      typeof m.generation === 'string' ||
      m.generation.scope !== scope(engine, binding))
  )
    fail('ACCESS_DENIED');
  for (const ref of unique([...m.reads, ...(m.acquisition?.reads ?? [])]))
    engine.get(ref, s, false, false);
  return clone(m);
}

export function present(
  engine: Engine,
  s: Session,
  receipt: MemoryReceipt,
  items: readonly AtomView[],
  text: string,
  range?: { start: number; end: number; unit?: 'utf8' | 'byte'; digest?: string },
): void {
  const m = engine.storage.metaGet<ReceiptManifest>(`sdk:manifest:${receipt.id}`);
  if (!m) return; // A host may disable transient receipt retention.
  let rendered: { ref: AtomRef; quote?: PresentationUnit['quote'] }[] = [];
  try {
    const value = JSON.parse(text);
    if (value.formatVersion === 2 && Array.isArray(value.memory)) rendered = value.memory;
  } catch {}
  const units: PresentationUnit[] = items.map((item) => ({
    ref: item.ref,
    revision: engine.resolve(item.ref, s).target,
    digest: digest(item.text),
    ...(range ? { range: { start: range.start, end: range.end } } : {}),
    metadata: {
      links: item.links,
      sources: item.sources,
      provenance: item.provenance,
      state: item.state,
    },
    display: range ? 'range' : rendered.find((v) => v.ref === item.ref)?.quote ? 'quote' : 'body',
    ...(rendered.find((v) => v.ref === item.ref)?.quote
      ? { quote: rendered.find((v) => v.ref === item.ref)!.quote }
      : {}),
  }));
  m.presentation = { formatVersion: 2, digest: digest(text), units };
  if (range && m.acquisition)
    m.acquisition.ranges.push(
      ...units.map((unit) => ({
        revision: unit.revision,
        start: range.start,
        end: range.end,
        unit: range.unit ?? 'utf8',
        digest: range.digest ?? unit.digest,
      })),
    );
  engine.storage.metaSet(`sdk:manifest:${receipt.id}`, m);
}

/** Record a host's finalized input; this function neither sends it nor invokes a model. */
export function observe(engine: Engine, input: HostInput, binding: ClientBinding): InputToken {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some(
      (k) =>
        !['presentations', 'sources', 'inherit', 'watches', 'basis', 'payloadDigest'].includes(k),
    ) ||
    typeof input.payloadDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.payloadDigest) ||
    ![undefined, 'current', 'historical'].includes(input.basis)
  )
    fail('INVALID_INPUT');
  for (const list of [input.presentations, input.sources, input.inherit, input.watches])
    if (
      list !== undefined &&
      (!Array.isArray(list) || list.length > engine.kernel.limits.maxReadCandidates)
    )
      fail('LIMIT_EXCEEDED');
  const s = engine.session(binding);
  const reads: PinnedRef[] = [],
    current: PinnedRef[] = [],
    acquisition: PinnedRef[] = [];
  const observations: ReceiptManifest['observations'] = [],
    acquiredObservations: ReceiptManifest['observations'] = [];
  const presentations: Exclude<ReceiptManifest['generation'], string | undefined>['presentations'] =
    [];
  const sources: Origin[] = [];
  const ranges: import('../core/store.js').AcquiredRange[] = [];
  const historicalReads: PinnedRef[] = [];
  const inheritedOutputs: PinnedRef[] = [];
  const policies = new Set<string>([binding.writePolicy]);
  const include = (m: ReceiptManifest, watches: boolean) => {
    reads.push(...m.reads);
    acquisition.push(...(m.acquisition?.reads ?? m.reads));
    ranges.push(...(m.acquisition?.ranges ?? []));
    acquiredObservations.push(...(m.acquisition?.observations ?? m.observations));
    m.policies.forEach((p) => policies.add(p));
    if (watches) {
      current.push(...(m.currentReads ?? m.reads));
      observations.push(...m.observations);
    }
  };
  for (const entry of input.presentations ?? []) {
    if (!entry || Object.keys(entry).some((k) => !['receipt', 'refs'].includes(k)))
      fail('INVALID_INPUT');
    const m = manifest(engine, entry.receipt, binding);
    if (!m.presentation) fail('INVALID_INPUT', 'Receipt has no body presentation');
    if (entry.refs !== undefined && !Array.isArray(entry.refs)) fail('INVALID_INPUT');
    const wanted = new Set(entry.refs ?? m.presentation.units.map((u) => u.ref));
    const units = m.presentation.units.filter((u) => wanted.has(u.ref));
    if (wanted.size !== units.length) fail('INVALID_REF', 'Body was not in the presentation');
    include(m, input.basis !== 'historical');
    if (input.basis === 'historical') historicalReads.push(...m.reads);
    if (input.basis !== 'historical') current.push(...units.map((u) => u.revision));
    presentations.push({ receiptId: m.receipt.receiptId, digest: m.presentation.digest, units });
  }
  for (const token of input.inherit ?? []) {
    const m = inputManifest(engine, token, binding);
    include(m, true); // A fresh input scope cannot erase carried state or its watches.
    if (m.generation && typeof m.generation !== 'string') {
      historicalReads.push(...(m.generation.historicalReads ?? []));
      inheritedOutputs.push(...m.generation.outputs);
      reads.push(...m.generation.outputs);
    }
  }
  for (const receipt of input.watches ?? []) include(manifest(engine, receipt, binding), true);
  for (const citation of input.sources ?? []) {
    const source = engine.get(engine.resolve(citation.ref, s).target, s);
    if (source.provenance.kind !== 'source') fail('ACCESS_DENIED');
    const start = citation.start ?? 0;
    const end =
      citation.end ??
      (source.body.kind === 'blob' ? source.body.bytes : Buffer.byteLength(engine.text(source)));
    const bytes =
      source.body.kind === 'blob'
        ? engine.storage.blobRange?.(source.body.blobId, start, end - start)
        : Buffer.from(engine.text(source)).subarray(start, end);
    if (!bytes) fail('REFERENCE_UNAVAILABLE');
    s.ledger.charge({ maxBytes: bytes.length });
    const origin: Origin = {
      source: pinRevision(source),
      selector: { kind: 'utf8', start, end, quoteDigest: digest(bytes) },
    };
    validateOrigin(origin, source, (id) => {
      const blob = engine.storage.metaGet<{ bytes: string }>(`blob:${id}`);
      return blob ? Buffer.from(blob.bytes, 'base64') : undefined;
    });
    sources.push(origin);
    ranges.push({
      revision: origin.source,
      start,
      end,
      unit: 'utf8',
      digest: origin.selector.quoteDigest!,
    });
    reads.push(origin.source);
    acquisition.push(origin.source);
    policies.add(source.policyId);
    if (input.basis !== 'historical') current.push(origin.source);
  }
  const id = uid('input') as InputToken;
  const m: ReceiptManifest = {
    contractVersion: 2,
    dependencyContract: 'observed',
    receipt: { receiptId: id },
    subject: s.principal.subject,
    authBinding: bindingKey(binding.auth),
    authorityGeneration: s.principal.generation,
    generation: {
      id: uid('generation'),
      scope: scope(engine, binding),
      payloadDigest: input.payloadDigest,
      presentations,
      sources,
      inherited: [...new Set(input.inherit ?? [])],
      inheritedOutputs: unique(inheritedOutputs),
      historicalReads: unique(historicalReads),
      outputs: [],
    },
    policies: [...policies],
    watermark: s.at,
    reads: unique(reads),
    currentReads: unique(current),
    observations,
    acquisition: {
      reads: unique(acquisition),
      ranges,
      observations: acquiredObservations,
      index: engine.storage.metaGet<number>('sdk:index-generation') ?? 0,
    },
    watches: { reads: unique(current), observations },
    expiresAt: Date.now() + (engine.options.cursorTtlMs ?? 300000),
  };
  s.ledger.charge({ maxBytes: Buffer.byteLength(canonical(m)), maxCandidates: m.reads.length });
  engine.check(s);
  engine.storage.metaSet(`receipt:${id}`, m);
  return id;
}

export function inputManifest(
  engine: Engine,
  token: InputToken,
  binding: ClientBinding,
): ReceiptManifest {
  if (typeof token !== 'string') fail('INVALID_INPUT', 'InputToken must be issued by host.observe');
  return manifest(engine, token, binding);
}

/** Only a trusted source ingestion can exclude relation validation from derivation. */
export function sourceManifest(
  engine: Engine,
  id: string,
  origins: readonly Origin[],
  policy: string,
): void {
  const m = engine.storage.metaGet<ReceiptManifest>(`receipt:${id}`)!;
  m.dependencyContract = 'source';
  m.policies = [policy];
  m.reads = unique(origins.map((o) => o.source));
  m.currentReads = [];
  m.observations = [];
  m.watches = { reads: [], observations: [] };
  engine.storage.metaSet(`receipt:${id}`, m);
}

export function attachOutputs(engine: Engine, id: string, outputs: readonly PinnedRef[]): void {
  const m = engine.storage.metaGet<ReceiptManifest>(`receipt:${id}`)!;
  m.ownedRevisionIds = [
    ...new Set([...(m.ownedRevisionIds ?? []), ...outputs.map((r) => r.revisionId)]),
  ];
  if (m.generation && typeof m.generation !== 'string')
    m.generation.outputs = unique([...m.generation.outputs, ...outputs]);
  if (m.dependencyContract === 'observed')
    m.currentReads = (m.currentReads ?? []).map(
      (ref) => outputs.find((output) => output.atomId === ref.atomId) ?? ref,
    );
  // Adjust only the effects of this atomic commit. Concurrent changes were checked by AtomicStore.
  m.observations = m.observations.map((o) => ({
    ...o,
    watermark: engine.storage.watermark(),
    revisionIds: engine.storage.scan(o.query, engine.storage.watermark()).map((r) => r.revisionId),
  }));
  if (m.watches) m.watches = { reads: m.currentReads ?? [], observations: m.observations };
  engine.storage.metaSet(`receipt:${id}`, m);
}

/** Resolve identities saved in this commit for explicitly inherited generations only. */
export function attachInheritedOutputs(engine: Engine, id: string): void {
  const m = engine.storage.metaGet<ReceiptManifest>(`receipt:${id}`)!;
  const generation = m.generation;
  if (!generation || typeof generation === 'string') return;
  const refs = generation.inherited.flatMap((parentId) => {
    const parent = engine.storage.metaGet<ReceiptManifest>(`receipt:${parentId}`);
    return parent?.generation && typeof parent.generation !== 'string'
      ? parent.generation.outputs
      : [];
  });
  generation.inheritedOutputs = unique([...(generation.inheritedOutputs ?? []), ...refs]);
  m.reads = unique([...m.reads, ...refs]);
  engine.storage.metaSet(`receipt:${id}`, m);
}
