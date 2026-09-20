import type { Vec3 } from './types.js';

/**
 * Manual evidence model.
 *
 * Every row of a migration plan begins with machine evidence (geometric
 * candidates and their classification). An engineer may then:
 *
 *  - confirm a specific candidate pair (even when the machine called it
 *    ambiguous);
 *  - disable a candidate the machine suggested;
 *  - mark an object for manual rebuild (no automatic target is produced);
 *  - leave the row untouched (machine proposal stands).
 *
 * Decisions are first-class records, never overwritten silently.
 */

export type EntityKind = 'load' | 'constraint' | 'probe' | 'zone';

export type DecisionAction = 'confirm' | 'disable' | 'rebuild' | 'reset';

export type CandidateRef =
  | { type: 'node'; oldId: string | null; newId: string | null }
  | { type: 'face'; oldKey: string | null; newKey: string | null }
  | { type: 'element'; oldId: string | null; newId: string | null };

export interface Decision {
  id: string;
  entityKind: EntityKind;
  entityId: string;
  action: DecisionAction;
  candidate?: CandidateRef;
  note?: string;
  author: string;
  createdAt: string;
}

export type MigrationStatus =
  | 'complete'
  | 'split'
  | 'merged'
  | 'ambiguous'
  | 'unmatched'
  | 'disabled'
  | 'rebuild';

export interface ConservationCheck {
  oldForce: Vec3;
  newForce: Vec3;
  forceError: number;
  forceScale: number;
  forceOk: boolean;
  oldMoment: Vec3;
  newMoment: Vec3;
  momentError: number;
  momentScale: number;
  momentOk: boolean;
}
