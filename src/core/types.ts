/**
 * Domain types for versioned FEA mesh migration.
 *
 * Coordinate system: right-handed 3D Cartesian. Length unit is arbitrary but
 * must be consistent across two mesh versions compared in one plan.
 *
 * Topology identifiers are orientation-insensitive tuples of node indices:
 * an edge is [min,max], a triangle face is [a,b,c] sorted ascending.
 * Engineering orientation (element winding, outward normal) is carried
 * separately and never encoded into the topological key.
 */

export type Vec3 = [number, number, number];

export type DofId = 'ux' | 'uy' | 'uz';

export interface Node {
  id: string;
  coord: Vec3;
}

/** Linear tetrahedron. Node winding follows the right-hand rule (outward). */
export interface Element {
  id: string;
  nodes: [string, string, string, string];
  /** Material partition id; must resolve to a Zone. */
  zone: string;
}

/** Boundary triangle. Winding defines the outward surface normal. */
export interface Face {
  id: string;
  nodes: [string, string, string];
  /** Stable membership in a named boundary region (set semantics). */
  region?: string;
}

export type LoadKind = 'facePressure' | 'nodalForce';

export interface FacePressureLoad {
  id: string;
  kind: 'facePressure';
  /** Faces the load acts on, identified by stable topological face key. */
  faces: string[];
  /** Pressure magnitude > 0, acting along the per-face outward normal. */
  pressure: number;
}

export interface NodalForceLoad {
  id: string;
  kind: 'nodalForce';
  node: string;
  vector: Vec3;
}

export type Load = FacePressureLoad | NodalForceLoad;

export interface Constraint {
  id: string;
  node: string;
  fixed: DofId[];
}

export interface Probe {
  id: string;
  label: string;
  coord: Vec3;
}

export interface Zone {
  id: string;
  name: string;
  /** Material parameters; opaque to the migration engine. */
  material: Record<string, number>;
}

/**
 * Named boundary region stored with set semantics.
 *
 * The member set is topological face keys. A region id is stable across
 * delete-and-rebuild as long as the rebuild keeps the same `id`; the export
 * order is always the member keys sorted ascending, independent of insertion
 * history, so a delete/rebuild round-trip is byte-for-byte stable.
 */
export interface BoundaryRegion {
  id: string;
  name: string;
  members: string[];
}

export interface Mesh {
  schema: 'fem-json/1';
  id: string;
  name: string;
  nodes: Node[];
  elements: Element[];
  faces: Face[];
  zones: Zone[];
  loads: Load[];
  constraints: Constraint[];
  probes: Probe[];
  boundaryRegions?: BoundaryRegion[];
}

/** Canonical, orientation-insensitive topological key for a node tuple. */
export function nodeTupleKey(ids: readonly string[]): string {
  return [...ids].sort().join(',');
}

export function faceKey(ids: readonly string[]): string {
  return nodeTupleKey(ids);
}

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
