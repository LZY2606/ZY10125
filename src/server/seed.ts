import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Mesh } from '../core/types.js';
import type { MigrationService } from './service.js';

/**
 * Idempotently ingest committed fixture meshes on first boot. Meshes are
 * content-addressed, so re-running this after a fixture change simply adds a
 * new version; nothing is ever overwritten.
 */
export function seedFixtures(service: MigrationService, fixturesDir: string): { ingested: number; rejected: number } {
  let ingested = 0;
  let rejected = 0;
  for (const name of readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()) {
    const mesh = JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as Mesh;
    try {
      const res = service.ingestMesh(mesh);
      if (res.created) ingested++;
    } catch {
      // Deliberately-broken fixtures (inverted/degenerate elements) must not
      // stop the valid fixtures from seeding.
      rejected++;
    }
  }
  return { ingested, rejected };
}
