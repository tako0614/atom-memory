import { createHash, randomUUID } from 'node:crypto';
import type { ErrorCode, Json } from '../contracts.js';
export class AtomMemoryError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'AtomMemoryError';
  }
}
export function fail(code: ErrorCode, message?: string): never {
  throw new AtomMemoryError(code, message);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return fail('INVALID_SCHEMA', 'Expected finite JSON data');
}
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function uid(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
export function clone<T>(value: T): T {
  return structuredClone(value);
}
export function textOf(value: Json): string {
  return typeof value === 'string' ? value : canonical(value);
}
export function validId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 512)
    fail('INVALID_SCHEMA', 'Invalid identifier');
}
export function terms(text: string): string[] {
  return [
    ...new Set(
      text
        .normalize('NFKC')
        .toLowerCase()
        .match(/[\p{L}\p{N}_]+/gu) ?? [],
    ),
  ];
}
