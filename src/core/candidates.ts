import type { CandidateProvider } from '../client/types.js';
import { fail } from './util.js';
import { words, seedScore } from './ranking.js';
export { words, lexicalScore, cosine } from './ranking.js';
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
        if (input.vectors.length && !repr.vectors) pending = true;
        const score = scoreRepresentation(input, repr);
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
 * Embedding-only matches require the hybrid provider. Candidate limits and
 * later graph bounds mean this provider never certifies full coverage.
 */
export class LexicalCandidateProvider implements CandidateProvider {
  readonly id = 'local-body-lexical-v1';
  async retrieve(input: Parameters<CandidateProvider['retrieve']>[0]) {
    const terms = [...new Set(input.texts.flatMap(words))];
    if (!terms.length || input.vectors.length) return new ExactCandidateProvider().retrieve(input);
    const result = await new ExactCandidateProvider().retrieve({
      ...input,
      access: {
        ...input.access,
        page: (after, limit) => input.access.page(after, limit, { text: terms }),
      },
    });
    return { ...result, approximate: true };
  }
}

/** Bucket-based semantic ingress plus lexical candidates. Final scoring uses
 * actual vectors; graph expansion and permissions remain in the memory client. */
export class HybridCandidateProvider implements CandidateProvider {
  readonly id = 'local-hybrid-buckets-v1';
  async retrieve(
    input: Parameters<CandidateProvider['retrieve']>[0],
  ): ReturnType<CandidateProvider['retrieve']> {
    if (!input.vectors.length || !input.access.vectorCandidates)
      return new LexicalCandidateProvider().retrieve(input);
    const maximum = Math.min(
      256,
      Math.max(1, Math.floor(input.maxScan / 2)),
      input.ledger.remaining('maxCandidates'),
    );
    const candidates: Awaited<ReturnType<CandidateProvider['retrieve']>>['candidates'] = [];
    let pending = false;
    if (!input.after)
      for (const revision of input.access.vectorCandidates(input.vectors, maximum)) {
        if (input.signal.aborted) fail('ABORTED');
        if (!input.ledger.can({ maxCandidates: 1 })) break;
        let representation;
        try {
          representation = input.access.representation(revision);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'BUDGET_EXHAUSTED') break;
          throw error;
        }
        const bytes = Buffer.byteLength(representation.text);
        if (!input.ledger.can({ maxCandidates: 1, maxBytes: bytes })) break;
        input.ledger.charge({ maxCandidates: 1, maxBytes: bytes });
        if (!representation.vectors) pending = true;
        const score = scoreRepresentation(input, representation);
        if (score > 0) candidates.push({ revision, score });
      }
    const lexical = await new LexicalCandidateProvider().retrieve({
      ...input,
      vectors: [],
      maxScan: Math.max(0, input.maxScan - candidates.length),
    });
    const merged = new Map(candidates.map((c) => [c.revision.revisionId, c]));
    for (const candidate of lexical.candidates) {
      const old = merged.get(candidate.revision.revisionId);
      if (!old || candidate.score > old.score) merged.set(candidate.revision.revisionId, candidate);
    }
    return {
      ...lexical,
      candidates: [...merged.values()].sort(
        (a, b) => b.score - a.score || a.revision.atomId.localeCompare(b.revision.atomId),
      ),
      scanned: lexical.scanned + candidates.length,
      pending: pending || lexical.pending,
      approximate: true,
    };
  }
}

function scoreRepresentation(
  input: Parameters<CandidateProvider['retrieve']>[0],
  representation: { text: string; vectors?: readonly (readonly number[])[] },
) {
  const signals = input.signals ?? [
    ...input.texts.map((text) => ({ kind: 'query' as const, text })),
    ...input.vectors.map((vector) => ({ kind: 'signal' as const, vector })),
  ];
  return seedScore(representation.text, representation.vectors, signals, input.ranking);
}
