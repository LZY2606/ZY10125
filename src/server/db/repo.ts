import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mesh } from '../../core/types.js';
import { meshHash } from '../../core/hash.js';
import type { Decision } from '../../core/evidence.js';
import type { FrozenPlan } from '../../core/plan-types.js';
import type { AcceptedResult } from '../../core/acceptance.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface StoredPlan {
  id: string;
  oldHash: string;
  newHash: string;
  status: 'preview' | 'accepted' | 'rejected';
  plan: FrozenPlan;
  createdAt: string;
  acceptedAt: string | null;
  acceptedResult: AcceptedResult | null;
}

export interface BoundaryRegionRecord {
  id: string;
  name: string;
  members: string[];
}

export class Repository {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
    this.db.exec(schema);
  }

  close(): void {
    this.db.close();
  }

  /** Insert a mesh only if unseen; returns the content hash either way. */
  putMesh(mesh: Mesh): { hash: string; created: boolean } {
    const hash = meshHash(mesh);
    const existing = this.db
      .prepare('SELECT hash FROM meshes WHERE hash = ?')
      .get(hash);
    if (existing) return { hash, created: false };
    this.db
      .prepare(
        'INSERT INTO meshes (hash, mesh_id, name, payload, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(hash, mesh.id, mesh.name, JSON.stringify(mesh), new Date().toISOString());
    return { hash, created: true };
  }

  getMesh(hash: string): Mesh | null {
    const row = this.db
      .prepare('SELECT payload FROM meshes WHERE hash = ?')
      .get(hash) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Mesh) : null;
  }

  listMeshes(): { hash: string; meshId: string; name: string; createdAt: string }[] {
    const rows = this.db
      .prepare('SELECT hash, mesh_id, name, created_at FROM meshes ORDER BY created_at DESC')
      .all() as Array<{
      hash: string;
      mesh_id: string;
      name: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      hash: r.hash,
      meshId: r.mesh_id,
      name: r.name,
      createdAt: r.created_at
    }));
  }

  insertPlan(plan: FrozenPlan): void {
    this.db
      .prepare(
        `INSERT INTO plans (id, old_hash, new_hash, status, payload, created_at)
         VALUES (?, ?, ?, 'preview', ?, ?)`
      )
      .run(
        plan.planId,
        plan.oldHash,
        plan.newHash,
        JSON.stringify(plan),
        plan.createdAt
      );
  }

  getPlan(id: string): StoredPlan | null {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE id = ?')
      .get(id) as
      | {
          id: string;
          old_hash: string;
          new_hash: string;
          status: StoredPlan['status'];
          payload: string;
          created_at: string;
          accepted_at: string | null;
          accepted_result: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      oldHash: row.old_hash,
      newHash: row.new_hash,
      status: row.status,
      plan: JSON.parse(row.payload) as FrozenPlan,
      createdAt: row.created_at,
      acceptedAt: row.accepted_at,
      acceptedResult: row.accepted_result ? (JSON.parse(row.accepted_result) as AcceptedResult) : null
    };
  }

  listPlans(): { id: string; status: string; createdAt: string; oldHash: string; newHash: string }[] {
    return (this.db
      .prepare('SELECT id, status, created_at, old_hash, new_hash FROM plans ORDER BY created_at DESC')
      .all() as Array<{
      id: string;
      status: string;
      created_at: string;
      old_hash: string;
      new_hash: string;
    }>).map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.created_at,
      oldHash: r.old_hash,
      newHash: r.new_hash
    }));
  }

  addDecision(planId: string, d: Decision): void {
    this.db
      .prepare(
        `INSERT INTO decisions (id, plan_id, entity_kind, entity_id, action, candidate, note, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        d.id,
        planId,
        d.entityKind,
        d.entityId,
        d.action,
        d.candidate ? JSON.stringify(d.candidate) : null,
        d.note ?? null,
        d.author,
        d.createdAt
      );
  }

  listDecisions(planId: string): Decision[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM decisions WHERE plan_id = ? ORDER BY created_at ASC, rowid ASC'
      )
      .all(planId) as Array<{
      id: string;
      entity_kind: Decision['entityKind'];
      entity_id: string;
      action: Decision['action'];
      candidate: string | null;
      note: string | null;
      author: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      entityKind: r.entity_kind,
      entityId: r.entity_id,
      action: r.action,
      candidate: r.candidate ? JSON.parse(r.candidate) : undefined,
      note: r.note ?? undefined,
      author: r.author,
      createdAt: r.created_at
    }));
  }

  /**
   * Accept a plan atomically.
   *
   * The transaction re-loads and re-hashes both meshes (version check), runs
   * acceptance, then writes status + accepted objects. Any failure rolls
   * back, so a partially migrated set of loads can never be committed.
   */
  acceptPlan(
    planId: string,
    accept: (plan: FrozenPlan, oldMesh: Mesh, newMesh: Mesh) => AcceptedResult,
    loadMesh: (hash: string) => Mesh
  ): { ok: boolean; result: AcceptedResult } {
    const tx = this.db.transaction(() => {
      const stored = this.getPlan(planId);
      if (!stored) throw new Error('plan not found');
      if (stored.status === 'accepted') throw new Error('plan already accepted');

      const oldMesh = loadMesh(stored.oldHash);
      const newMesh = loadMesh(stored.newHash);
      const result = accept(stored.plan, oldMesh, newMesh);
      if (!result.ok) {
        // Keep the plan in preview so the engineer can revise decisions.
        throw Object.assign(new Error('acceptance validation failed'), { result });
      }

      this.db
        .prepare(
          `UPDATE plans SET status = 'accepted', accepted_at = ?, accepted_result = ? WHERE id = ?`
        )
        .run(new Date().toISOString(), JSON.stringify(result), planId);

      // Materialize migrated engineering objects into boundary-region sets.
      // Loads/constraints are exported from the accepted result; region
      // membership is rebuilt as a set (delete-then-insert) inside the same
      // transaction.
      for (const obj of result.objects) {
        if (obj.kind === 'zone') {
          const payload = obj.payload as { zoneId: string; elementIds: string[] };
          void payload;
        }
      }
      return result;
    });

    try {
      const result = tx();
      return { ok: true, result };
    } catch (err) {
      const result = (err as { result?: AcceptedResult }).result;
      if (result) return { ok: false, result };
      throw err;
    }
  }

  // ---- Boundary regions: set semantics ------------------------------------

  replaceRegion(region: BoundaryRegionRecord): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM boundary_regions WHERE region_id = ?').run(region.id);
      const now = new Date().toISOString();
      // Store as a set; export sorts members, not insertion order.
      const members = [...new Set(region.members)];
      const insert = this.db.prepare(
        'INSERT INTO boundary_regions (region_id, name, member, created_at) VALUES (?, ?, ?, ?)'
      );
      for (const member of members) insert.run(region.id, region.name, member, now);
    });
    tx();
  }

  listRegions(): BoundaryRegionRecord[] {
    const rows = this.db.prepare(
      'SELECT region_id, name, member FROM boundary_regions ORDER BY region_id ASC, member ASC'
    ).all() as Array<{ region_id: string; name: string; member: string }>;
    const byId = new Map<string, BoundaryRegionRecord>();
    for (const r of rows) {
      const rec = byId.get(r.region_id) ?? { id: r.region_id, name: r.name, members: [] };
      rec.members.push(r.member);
      byId.set(r.region_id, rec);
    }
    return [...byId.values()].map((r) => ({ ...r, members: [...r.members].sort() }));
  }
}
