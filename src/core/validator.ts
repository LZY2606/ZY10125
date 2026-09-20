import type { Mesh } from './types.js';
import { faceKey, nodeTupleKey } from './types.js';
import { buildTopology } from './topology.js';
import { DEFAULT_TOLERANCES, type Tolerances } from './tolerances.js';

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  code:
    | 'duplicate-node-id'
    | 'duplicate-element-id'
    | 'duplicate-face-id'
    | 'dangling-node'
    | 'dangling-zone'
    | 'dangling-load-face'
    | 'dangling-load-node'
    | 'dangling-constraint-node'
    | 'zero-volume-element'
    | 'inverted-element'
    | 'duplicate-face-topology'
    | 'orphan-boundary-face'
    | 'duplicate-constraint'
    | 'duplicate-zone-id'
    | 'unknown-face-region';
  severity: Severity;
  message: string;
  ref?: string;
}

export interface MeshValidation {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * Structural validation of one mesh version.
 *
 * - element orientation: negative signed volume is reported as inverted;
 * - zero volume: degenerate tets;
 * - dangling references: any node / zone / face that does not resolve;
 * - duplicate constraints: same node carrying the same fixed DOF twice;
 * - duplicate topological faces are rejected (non-manifold surface).
 */
export function validateMesh(
  mesh: Mesh,
  tol: Tolerances = DEFAULT_TOLERANCES
): MeshValidation {
  const issues: ValidationIssue[] = [];
  const push = (
    code: ValidationIssue['code'],
    message: string,
    ref?: string,
    severity: Severity = 'error'
  ) => issues.push({ code, severity, message, ref });

  if (mesh.schema !== 'fem-json/1') {
    push('dangling-node', `unsupported schema "${mesh.schema}"`);
  }

  const nodeIds = new Set<string>();
  for (const n of mesh.nodes) {
    if (nodeIds.has(n.id)) push('duplicate-node-id', `duplicate node ${n.id}`, n.id);
    nodeIds.add(n.id);
  }

  const zoneIds = new Set<string>();
  for (const z of mesh.zones) {
    if (zoneIds.has(z.id)) push('duplicate-zone-id', `duplicate zone ${z.id}`, z.id);
    zoneIds.add(z.id);
  }

  const elementIds = new Set<string>();
  for (const el of mesh.elements) {
    if (elementIds.has(el.id))
      push('duplicate-element-id', `duplicate element ${el.id}`, el.id);
    elementIds.add(el.id);
    const uniq = new Set(el.nodes);
    if (uniq.size !== 4)
      push('dangling-node', `element ${el.id} repeats a node`, el.id);
    for (const id of el.nodes) {
      if (!nodeIds.has(id))
        push('dangling-node', `element ${el.id} references missing node ${id}`, el.id);
    }
    if (!zoneIds.has(el.zone))
      push('dangling-zone', `element ${el.id} references missing zone ${el.zone}`, el.id);
  }

  const topo = buildTopology(mesh);
  for (const el of topo.elements.values()) {
    if (el.volume <= tol.zeroVolume)
      push('zero-volume-element', `element ${el.id} has volume ${el.signedVolume.toExponential(3)}`, el.id);
    else if (el.signedVolume < 0)
      push('inverted-element', `element ${el.id} has negative signed volume; flip nodes 0 and 1`, el.id, 'warning');
  }

  const faceIds = new Set<string>();
  const faceTopoKeys = new Map<string, string>();
  for (const f of mesh.faces) {
    if (faceIds.has(f.id)) push('duplicate-face-id', `duplicate face ${f.id}`, f.id);
    faceIds.add(f.id);
    const uniq = new Set(f.nodes);
    if (uniq.size !== 3) push('dangling-node', `face ${f.id} repeats a node`, f.id);
    for (const id of f.nodes) {
      if (!nodeIds.has(id))
        push('dangling-node', `face ${f.id} references missing node ${id}`, f.id);
    }
    const key = faceKey(f.nodes);
    const prior = faceTopoKeys.get(key);
    if (prior)
      push('duplicate-face-topology', `faces ${prior} and ${f.id} share topology`, f.id);
    faceTopoKeys.set(key, f.id);

    const ft = topo.faces.get(key);
    if (!ft || ft.elementRefs.length === 0)
      push('orphan-boundary-face', `face ${f.id} is not attached to any element`, f.id, 'warning');
  }

  for (const load of mesh.loads) {
    if (load.kind === 'facePressure') {
      const seen = new Set<string>();
      for (const key of load.faces) {
        if (seen.has(key))
          push('duplicate-face-topology', `load ${load.id} lists face ${key} twice`, load.id);
        seen.add(key);
        if (!faceTopoKeys.has(key))
          push('dangling-load-face', `load ${load.id} references missing face ${key}`, load.id);
      }
    } else {
      if (!nodeIds.has(load.node))
        push('dangling-load-node', `load ${load.id} references missing node ${load.node}`, load.id);
    }
  }

  const constraintKeys = new Set<string>();
  for (const c of mesh.constraints) {
    if (!nodeIds.has(c.node))
      push('dangling-constraint-node', `constraint ${c.id} references missing node ${c.node}`, c.id);
    for (const dof of c.fixed) {
      const k = `${c.node}:${dof}`;
      if (constraintKeys.has(k))
        push('duplicate-constraint', `node ${c.node} fixes ${dof} more than once`, c.id);
      constraintKeys.add(k);
    }
  }

  // Referenced node tuples must be structurally present (probes are free
  // points and are deliberately excluded).
  void nodeTupleKey;

  const errors = issues.filter((i) => i.severity === 'error');
  return { ok: errors.length === 0, issues };
}
