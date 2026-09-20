import './style.css';
import { api } from './api.js';
import { render } from './render.js';

export const state = {
  meshes: [],
  fromId: null,
  toId: null,
  plan: null,
  toleranceDraft: {},
  busy: false,
  error: null,
};

export async function refreshMeshes(select) {
  const { meshes } = await api.meshes();
  state.meshes = meshes;
  if (select) {
    state.fromId = select.fromId ?? state.fromId;
    state.toId = select.toId ?? state.toId;
  }
}

export function setSelection(which, id) {
  state[which === 'from' ? 'fromId' : 'toId'] = id ? Number(id) : null;
}

export async function createPlan(tolerances) {
  if (!state.fromId || !state.toId) throw new Error('请先选择两个网格版本');
  const { planId, preview } = await api.createPlan(state.fromId, state.toId, tolerances);
  const { plan } = await loadPlan(planId);
  return { planId, preview };
}

export async function loadPlan(id) {
  state.plan = await api.plan(id);
  return { plan: state.plan };
}

export async function addEvidence(ev) {
  await api.evidence(state.plan.id, ev);
  state.plan = await api.plan(state.plan.id);
}

export async function acceptPlan() {
  state.plan = await api.accept(state.plan.id);
}

async function boot() {
  await refreshMeshes();
  render();
}
boot().catch((err) => {
  state.error = err.message;
  render();
});
