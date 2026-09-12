import type { AtomContent, Origin, PinnedRef, Slot } from '../contracts.js';
import { digest, fail } from './util.js';
export const logical = (atomId: string) => ({ kind: 'logical' as const, atomId });
export const pin = (atomId: string, revisionId: string): PinnedRef => ({
  kind: 'pinned',
  atomId,
  revisionId,
});
export function content(
  schema: string,
  value: import('../contracts.js').Json,
  policyId: string,
  options: Partial<Omit<AtomContent, 'schema' | 'body' | 'policyId'>> = {},
): AtomContent {
  return {
    schema,
    state: 'active',
    body: { kind: 'inline', value },
    slots: [],
    origins: [],
    provenance: { kind: schema === 'source' ? 'source' : 'organization', producerId: 'host' },
    ...options,
    policyId,
  };
}
export function membership(
  group: string,
  member: string,
  policyId: string,
  orderKey?: string,
): AtomContent {
  const slots: Slot[] = [
    { role: 'group', mode: 'refer', target: logical(group) },
    {
      role: 'member',
      mode: 'refer',
      target: logical(member),
      ...(orderKey === undefined ? {} : { orderKey }),
    },
  ];
  return content('membership', null, policyId, { slots });
}
/** Coordinate in the exact stored UTF-8 source; never silently normalize offsets. */
export function origin(
  source: PinnedRef,
  text: string,
  start = 0,
  end = Buffer.byteLength(text),
): Origin {
  const bytes = Buffer.from(text);
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
  return {
    source,
    selector: { kind: 'utf8', start, end, quoteDigest: digest(bytes.subarray(start, end)) },
  };
}
/** Source coverage is an interval union; generated statements remain separate Atoms. */
export function sourceCoverage(
  origins: readonly Origin[],
): { source: PinnedRef; ranges: { start: number; end: number }[]; bytes: number }[] {
  const grouped = new Map<
    string,
    { source: PinnedRef; ranges: { start: number; end: number }[] }
  >();
  for (const o of origins) {
    const key = JSON.stringify(o.source);
    const entry = grouped.get(key) ?? { source: o.source, ranges: [] };
    entry.ranges.push({ start: o.selector.start, end: o.selector.end });
    grouped.set(key, entry);
  }
  return [...grouped.values()].map((entry) => {
    const ranges: { start: number; end: number }[] = [];
    for (const r of entry.ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
      const last = ranges.at(-1);
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else ranges.push({ ...r });
    }
    return { source: entry.source, ranges, bytes: ranges.reduce((n, r) => n + r.end - r.start, 0) };
  });
}
