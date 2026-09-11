import type { CandidateProvider } from '../client/types.js';
import { fail } from './util.js';
const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
export function words(text: string): string[] {
  return [
    ...new Set(
      [...segmenter.segment(text.normalize('NFKC').toLowerCase())]
        .filter((s) => s.isWordLike)
        .map((s) => s.segment),
    ),
  ];
}
export function lexicalScore(text: string, signals: readonly string[]): number {
  const haystack = text.normalize('NFKC').toLowerCase();
  return Math.max(
    0,
    ...signals.map((signal) => {
      const tokens = words(signal);
      if (!tokens.length) return 0;
      return tokens.filter((token) => haystack.includes(token)).length / tokens.length;
    }),
  );
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (
    a.length !== b.length ||
    a.some((n) => !Number.isFinite(n)) ||
    b.some((n) => !Number.isFinite(n))
  )
    fail('MODEL_SPACE_MISMATCH');
  const norm =
    Math.sqrt(a.reduce((n, x) => n + x * x, 0)) * Math.sqrt(b.reduce((n, x) => n + x * x, 0));
  return norm ? Math.max(0, a.reduce((n, x, i) => n + x * b[i]!, 0) / norm) : 0;
}
/** Exhaustive local reference ranking within an explicit scan budget. Not ANN. */
export class ExactCandidateProvider implements CandidateProvider {
  readonly id = 'local-exact-lexical-vector-v1';
  async retrieve(
    input: Parameters<CandidateProvider['retrieve']>[0],
  ): ReturnType<CandidateProvider['retrieve']> {
    const candidates: Awaited<ReturnType<CandidateProvider['retrieve']>>['candidates'] = [];
    let after: string | undefined = input.after;
    let scanned = 0;
    let complete = false;
    let pending = false;
    while (scanned < input.maxScan && input.ledger.can({ maxCandidates: 1 })) {
      if (input.signal.aborted) fail('ABORTED');
      const count = Math.min(64, input.maxScan - scanned, input.ledger.remaining('maxCandidates'));
      const page = input.access.page(after, count);
      for (const revision of page) {
        if (input.signal.aborted) fail('ABORTED');
        let repr: ReturnType<typeof input.access.representation>;
        try {
          repr = input.access.representation(revision);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'BUDGET_EXHAUSTED')
            return { candidates, scanned, complete: false, after, pending, approximate: true };
          throw error;
        }
        const bytes = Buffer.byteLength(repr.text);
        if (!input.ledger.can({ maxCandidates: 1, maxBytes: bytes }))
          return { candidates, scanned, complete: false, after, pending, approximate: true };
        input.ledger.charge({ maxCandidates: 1, maxBytes: bytes });
        scanned++;
        after = revision.atomId;
        const lexical = lexicalScore(repr.text, input.texts);
        if (input.vectors.length && !repr.vectors) pending = true;
        const semantic = Math.max(
          0,
          ...input.vectors.flatMap((q) => (repr.vectors ?? []).map((v) => cosine(q, v))),
        );
        const score = Math.max(lexical, semantic);
        if (score > 0) candidates.push({ revision, score });
      }
      if (page.length < count) {
        complete = true;
        break;
      }
    }
    // Relevance first across the scanned scope, then stable IDs only for exact ties.
    candidates.sort(
      (a, b) => b.score - a.score || a.revision.atomId.localeCompare(b.revision.atomId, 'en'),
    );
    return { candidates, scanned, complete, after, pending, approximate: !complete };
  }
}

/** Body-text candidate ingress, followed by the same finite ranking and graph
 * expansion. Storage performs matching in the authorized snapshot before the
 * JS scan budget; unrelated early IDs cannot crowd every later match out.
 * This is a lexical approximation: link-only/embedding-only matches may differ
 * from the exhaustive reference provider, so it never certifies full coverage.
 */
export class LexicalCandidateProvider implements CandidateProvider {
  readonly id = 'local-body-lexical-v1';
  async retrieve(input: Parameters<CandidateProvider['retrieve']>[0]) {
    const terms = [...new Set(input.texts.flatMap(words))];
    if (!terms.length || input.vectors.length) return new ExactCandidateProvider().retrieve(input);
    const result = await new ExactCandidateProvider().retrieve({ ...input, access: {
      ...input.access, page: (after, limit) => input.access.page(after, limit, { text: terms }),
    } });
    return { ...result, approximate: true };
  }
}
