async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}
export const api = {
  meshes: () => req('GET', '/api/meshes'),
  mesh: (id) => req('GET', `/api/meshes/${id}`),
  plans: () => req('GET', '/api/plans'),
  createPlan: (fromMeshId, toMeshId, tolerances) => req('POST', '/api/plans', { fromMeshId, toMeshId, tolerances }),
  plan: (id) => req('GET', `/api/plans/${id}`),
  evidence: (id, ev) => req('POST', `/api/plans/${id}/evidence`, ev),
  accept: (id) => req('POST', `/api/plans/${id}/accept`),
};
