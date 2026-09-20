import type { DofId, Vec3 } from './types.js';
import type { ConservationCheck, MigrationStatus } from './evidence.js';
import type { Tolerances } from './tolerances.js';

export interface CandidateView {
  target: string;
  detail: string;
  metric: number;
  metricLabel: string;
}

interface RowBase {
  kind: string;
  id: string;
  label: string;
  status: MigrationStatus;
  /** Machine-readable + human-readable justification for the status. */
  reasons: string[];
  candidates: CandidateView[];
  /** Engineer decision applied on top of machine evidence, if any. */
  decisionId?: string;
}

export interface ProposedChildFace {
  faceKey: string;
  area: number;
  pressure: number;
  overlapArea: number;
}

export interface FacePressureRow extends RowBase {
  kind: 'facePressure';
  oldFaces: string[];
  proposed: ProposedChildFace[];
  coverage: number;
  uncoveredOldFaces: string[];
  conservation?: ConservationCheck;
}

export interface NodalForceRow extends RowBase {
  kind: 'nodalForce';
  oldNode: string;
  newNode: string | null;
  vector: Vec3;
  conservation?: ConservationCheck;
}

export interface ConstraintRow extends RowBase {
  kind: 'constraint';
  oldNode: string;
  newNode: string | null;
  fixed: DofId[];
}

export interface ProbeRow extends RowBase {
  kind: 'probe';
  coord: Vec3;
  newNode: string | null;
  distance: number;
}

export interface ZoneRow extends RowBase {
  kind: 'zone';
  zoneId: string;
  oldElementCount: number;
  newElementIds: string[];
  /** Old elements with no new element contained/identical. */
  uncoveredElements: string[];
}

export type PlanRow =
  | FacePressureRow
  | NodalForceRow
  | ConstraintRow
  | ProbeRow
  | ZoneRow;

export interface FrozenPlan {
  schema: 'migration-plan/1';
  planId: string;
  oldMeshId: string;
  newMeshId: string;
  oldHash: string;
  newHash: string;
  createdAt: string;
  tolerances: Tolerances;
  rows: PlanRow[];
  topologyDiff: {
    oldNodes: number;
    newNodes: number;
    oldEdges: number;
    newEdges: number;
    oldFaces: number;
    newFaces: number;
    oldElements: number;
    newElements: number;
    sharedEdges: number;
  };
}
