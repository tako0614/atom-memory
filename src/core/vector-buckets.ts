/** Sparse, deterministic random hyperplanes. An approximate ingress only;
 * the host reranks real vectors and validates revisions before reading them. */
export function vectorBuckets(vector: readonly number[]): number[] {
  if (!vector.length || vector.some((n) => !Number.isFinite(n)))
    throw new TypeError('Invalid vector');
  const result: number[] = [];
  for (let band = 0; band < 6; band++) {
    let bucket = 0;
    for (let bit = 0; bit < 12; bit++) {
      let seed = ((band * 12 + bit + 1) * 2654435761) >>> 0;
      let value = 0;
      for (let sample = 0; sample < 12; sample++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
        value += vector[seed % vector.length]! * (seed & 0x80000000 ? 1 : -1);
      }
      if (value >= 0) bucket |= 1 << bit;
    }
    result.push(bucket);
  }
  return result;
}
