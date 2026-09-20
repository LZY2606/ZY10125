export interface MeshMeta {
  hash: string;
  meshId: string;
  name: string;
  createdAt: string;
}

export interface CandidateView {
  target: string;
  detail: string;
  metric: number;
  metricLabel: string;
}

export interface PlanRow {
  kind: string;
  id: string;
  label: string;
  status: string;
  reasons: string[];
  candidates: CandidateView[];
  decisionId?: string;
  conservation?: {
    oldForce: number[];
    newForce: number[];
    forceError: number;
    forceOk: boolean;
    oldMoment: number[];
    newMoment: number[];
    momentError: number;
    momentOk: boolean;
  };
  proposed?: { faceKey: string; area: number; pressure: number; overlapArea: number }[];
  coverage?: number;
  newNode?: string | null;
  newElementIds?: string[];
}

export interface FrozenPlan {
  planId: string;
  oldMeshId: string;
  newMeshId: string;
  oldHash: string;
  newHash: string;
  createdAt: string;
  tolerances: Record<string, number | boolean>;
  rows: PlanRow[];
  topologyDiff: Record<string, number>;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listMeshes: () => req<MeshMeta[]>('/api/meshes'),
  getMesh: (hash: string) => req<unknown>(`/api/meshes/${hash}`),
  ingestMesh: (mesh: unknown) =>
    req<{ hash: string; created: boolean }>('/api/meshes', {
      method: 'POST',
      body: JSON.stringify(mesh)
    }),
  createPlan: (oldHash: string, newHash: string) =>
    req<FrozenPlan>('/api/plans', {
      method: 'POST',
      body: JSON.stringify({ oldHash, newHash })
    }),
  getPlan: (id: string) => req<{ plan: FrozenPlan; status: string; decisions: unknown[] }>(`/api/plans/${id}`),
  decide: (
    planId: string,
    body: {
      entityKind: string;
      entityId: string;
      action: string;
      candidate?: unknown;
      note?: string;
    }
  ) => req<FrozenPlan>(`/api/plans/${planId}/decisions`, { method: 'POST', body: JSON.stringify(body) }),
  commit: (planId: string) =>
    req<unknown>(`/api/plans/${planId}/commit`, { method: 'POST' }),
  exportUrl: (planId: string) => `/api/plans/${planId}/export`
};
