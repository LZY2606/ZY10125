import { randomUUID } from 'node:crypto';
import { Repository } from './db/repo.js';
import type { Mesh } from '../core/types.js';
import { validateMesh } from '../core/validator.js';
import { buildPlan } from '../core/plan.js';
import { acceptPlan } from '../core/acceptance.js';
import {
  DEFAULT_TOLERANCES,
  cloneTolerances,
  type Tolerances
} from '../core/tolerances.js';
import type { CandidateRef, Decision, EntityKind } from '../core/evidence.js';
import type { FrozenPlan } from '../core/plan-types.js';

export class ValidationError extends Error {
  constructor(public issues: unknown[]) {
    super('mesh validation failed');
  }
}

export class MigrationService {
  constructor(private repo: Repository) {}

  /** Validate then content-address a mesh version. */
  ingestMesh(mesh: Mesh): { hash: string; created: boolean; validation: ReturnType<typeof validateMesh> } {
    const validation = validateMesh(mesh);
    if (!validation.ok) throw new ValidationError(validation.issues);
    const res = this.repo.putMesh(mesh);
    return { ...res, validation };
  }

  getMesh(hash: string): Mesh | null {
    return this.repo.getMesh(hash);
  }

  listMeshes() {
    return this.repo.listMeshes();
  }

  /**
   * Create a frozen preview. Tolerances default at preview time and are
   * embedded in the stored plan; later default changes never affect it.
   */
  createPreview(
    oldHash: string,
    newHash: string,
    tolerances?: Partial<Tolerances>
  ): FrozenPlan {
    const oldMesh = this.requireMesh(oldHash);
    const newMesh = this.requireMesh(newHash);
    if (oldHash === newHash) throw new Error('source and target must be different mesh versions');
    const tol = { ...cloneTolerances(DEFAULT_TOLERANCES), ...(tolerances ?? {}) };
    const plan = buildPlan(oldMesh, newMesh, { tolerances: tol });
    this.repo.insertPlan(plan);
    return plan;
  }

  static normalizeEntityKind(kind: string): EntityKind {
    return kind === 'facePressure' || kind === 'nodalForce' ? 'load' : (kind as EntityKind);
  }

  getPlan(id: string) {
    return this.repo.getPlan(id);
  }

  listPlans() {
    return this.repo.listPlans();
  }

  listDecisions(planId: string) {
    return this.repo.listDecisions(planId);
  }

  /**
   * Append one manual decision and rebuild the plan from all evidence.
   * The frozen tolerances from the existing plan are reused verbatim.
   */
  applyDecision(
    planId: string,
    input: {
      entityKind: EntityKind;
      entityId: string;
      action: Decision['action'];
      candidate?: CandidateRef;
      note?: string;
      author?: string;
    }
  ): FrozenPlan {
    const stored = this.repo.getPlan(planId);
    if (!stored) throw new Error('plan not found');
    if (stored.status === 'accepted') throw new Error('plan is accepted and frozen');

    const decision: Decision = {
      id: randomUUID(),
      entityKind: MigrationService.normalizeEntityKind(input.entityKind),
      entityId: input.entityId,
      action: input.action,
      candidate: input.candidate,
      note: input.note,
      author: input.author ?? 'engineer',
      createdAt: new Date().toISOString()
    };
    this.repo.addDecision(planId, decision);

    const all = this.repo.listDecisions(planId);
    const oldMesh = this.requireMesh(stored.oldHash);
    const newMesh = this.requireMesh(stored.newHash);
    const rebuilt = buildPlan(oldMesh, newMesh, {
      tolerances: stored.plan.tolerances,
      decisions: all,
      planId: stored.plan.planId,
      createdAt: stored.plan.createdAt
    });
    this.updatePlanPayload(planId, rebuilt);
    return rebuilt;
  }

  /**
   * Commit. Re-reads the stored immutable meshes; stale hashes or failed
   * conservative checks abort the whole SQLite transaction.
   */
  commit(planId: string) {
    return this.repo.acceptPlan(
      planId,
      (plan, oldMesh, newMesh) => acceptPlan(plan, oldMesh, newMesh),
      (hash) => this.requireMesh(hash)
    );
  }

  /** Export accepted objects as a self-contained JSON document. */
  exportAccepted(planId: string) {
    const stored = this.repo.getPlan(planId);
    if (!stored) throw new Error('plan not found');
    if (stored.status !== 'accepted' || !stored.acceptedResult)
      throw new Error('plan is not accepted');
    const newMesh = this.requireMesh(stored.newHash);
    return {
      schema: 'migration-export/1',
      planId,
      newMeshId: newMesh.id,
      newHash: stored.newHash,
      frozenTolerances: stored.plan.tolerances,
      migrated: stored.acceptedResult.objects,
      blocked: stored.plan.rows
        .filter(
          (r) =>
            r.status === 'ambiguous' ||
            r.status === 'unmatched' ||
            r.status === 'disabled' ||
            r.status === 'rebuild'
        )
        .map((r) => ({ id: r.id, kind: r.kind, status: r.status, reasons: r.reasons }))
    };
  }

  listRegions() {
    return this.repo.listRegions();
  }

  replaceRegion(region: { id: string; name: string; members: string[] }) {
    this.repo.replaceRegion(region);
    return this.repo.listRegions().find((r) => r.id === region.id);
  }

  private requireMesh(hash: string): Mesh {
    const mesh = this.repo.getMesh(hash);
    if (!mesh) throw new Error(`mesh ${hash} not found`);
    return mesh;
  }

  private updatePlanPayload(planId: string, plan: FrozenPlan): void {
    // Small dedicated statement kept on the service to avoid a wide repo API.
    this.repo.db
      .prepare('UPDATE plans SET payload = ? WHERE id = ?')
      .run(JSON.stringify(plan), planId);
  }
}
