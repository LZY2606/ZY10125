/**
 * Numeric tolerances.
 *
 * A snapshot of these values is embedded in every migration plan at preview
 * time. Acceptance validates against the frozen snapshot, never against the
 * current defaults: changing a default here never rewrites an already
 * accepted plan.
 */
export interface Tolerances {
  /** Two nodes are the same physical point when within this distance. */
  nodeSnap: number;
  /** Max acceptable distance from a new face to the old face plane. */
  facePlane: number;
  /** Max deviation of face-normal dot product from 1 (radians-ish). */
  normalAngle: number;
  /** Centroid must project within the old face plus this slack. */
  centroidProjection: number;
  /** Below this absolute volume an element is degenerate. */
  zeroVolume: number;
  /** Probe must land within this radius of a mesh node. */
  probeSnap: number;
  /** Required fraction (0..1) of new faces covering an old face. */
  faceCoverage: number;
  /** Relative error allowed for conserved resultant force. */
  forceRelTol: number;
  /** Absolute floor for force comparisons (model units). */
  forceAbsTol: number;
  /** Relative error allowed for conserved resultant moment. */
  momentRelTol: number;
  /** Absolute floor for moment comparisons. */
  momentAbsTol: number;
  /** Require every element of a zone to map before accepting the zone. */
  zoneFullCoverage: boolean;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  nodeSnap: 1e-8,
  facePlane: 1e-7,
  normalAngle: 1e-6,
  centroidProjection: 1e-6,
  zeroVolume: 1e-12,
  probeSnap: 1e-7,
  faceCoverage: 1 - 1e-8,
  forceRelTol: 1e-8,
  forceAbsTol: 1e-10,
  momentRelTol: 1e-8,
  momentAbsTol: 1e-10,
  zoneFullCoverage: true
};

export function cloneTolerances(t: Tolerances): Tolerances {
  return { ...t };
}
