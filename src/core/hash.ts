import { createHash } from 'node:crypto';

/**
 * Content hash of a mesh.
 *
 * Canonicalization removes object key order but preserves array order where
 * order is semantically relevant. The hash covers geometry, topology AND all
 * attached engineering objects, so a grid is immutable once stored.
 */
export function meshHash(mesh: unknown): string {
  const json = canonicalJSON(mesh);
  return createHash('sha256').update(json).digest('hex');
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === 'number') return normalizeNumber(value);
  return value;
}

function normalizeNumber(n: number): number {
  // Round-trip keeps canonical form stable across platforms.
  return Number(n.toPrecision(15));
}
