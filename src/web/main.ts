import './style.css';
import { api, type FrozenPlan, type MeshMeta, type PlanRow } from './api.js';

const state: {
  meshes: MeshMeta[];
  oldHash: string;
  newHash: string;
  plan: FrozenPlan | null;
  planStatus: string;
} = {
  meshes: [],
  oldHash: '',
  newHash: '',
  plan: null,
  planStatus: 'preview'
};

const app = document.querySelector<HTMLDivElement>('#app')!;

function el(tag: string, props: Record<string, unknown> = {}, children: Node[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v as string;
    else if (k === 'text') node.textContent = v as string;
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.appendChild(c);
  return node;
}

function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  const t = el('div', { class: `toast ${kind}`, text: message });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

async function refreshMeshes(selectIds?: [string, string]): Promise<void> {
  state.meshes = await api.listMeshes();
  if (selectIds) {
    state.oldHash = selectIds[0];
    state.newHash = selectIds[1];
  }
  render();
}

async function uploadMesh(file: File): Promise<void> {
  try {
    const mesh = JSON.parse(await file.text());
    const res = await api.ingestMesh(mesh);
    toast(`网格已${res.created ? '入库' : '存在'}：${res.hash.slice(0, 12)}`);
    await refreshMeshes();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function createPlan(): Promise<void> {
  if (!state.oldHash || !state.newHash) return toast('请先选择两个网格版本', 'error');
  try {
    state.plan = await api.createPlan(state.oldHash, state.newHash);
    state.planStatus = 'preview';
    render();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function decide(row: PlanRow, action: string, target?: string): Promise<void> {
  if (!state.plan) return;
  const entityId = row.kind === 'zone' ? (row as unknown as { zoneId: string }).zoneId : row.id;
  const candidate =
    target == null
      ? undefined
      : row.kind === 'facePressure'
        ? { type: 'face', oldKey: null, newKey: target }
        : row.kind === 'zone'
          ? { type: 'element', oldId: null, newId: target }
          : { type: 'node', oldId: null, newId: target };
  try {
    state.plan = await api.decide(state.plan.planId, {
      entityKind: row.kind,
      entityId,
      action,
      candidate
    });
    render();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function commit(): Promise<void> {
  if (!state.plan) return;
  try {
    await api.commit(state.plan.planId);
    state.planStatus = 'accepted';
    toast('迁移方案已原子提交');
    render();
  } catch (err) {
    toast(`提交被拒绝：${(err as Error).message}`, 'error');
  }
}

function render(): void {
  app.innerHTML = '';
  app.appendChild(
    el('header', {}, [
      el('h1', { text: '有限元网格版本迁移台' }),
      el('span', { class: 'sub', text: '节点 / 边 / 面 / 单元对应 · 保守量校验 · 人工证据冻结' })
    ])
  );

  const main = el('main', { class: 'grid' });
  main.appendChild(renderSelector());
  if (state.plan) {
    main.appendChild(renderTopologyDiff());
    main.appendChild(renderRows());
    main.appendChild(renderFooter());
  }
  app.appendChild(main);
}

function meshOptions(): HTMLSelectElement {
  const select = el('select', {}) as HTMLSelectElement;
  select.appendChild(el('option', { value: '', text: '— 选择网格 —' }) as HTMLOptionElement);
  for (const m of state.meshes) {
    select.appendChild(
      el('option', { value: m.hash, text: `${m.name}  (${m.hash.slice(0, 10)}…)` }) as HTMLOptionElement
    );
  }
  return select;
}

function renderSelector(): HTMLElement {
  const oldSel = meshOptions();
  oldSel.value = state.oldHash;
  oldSel.addEventListener('change', () => (state.oldHash = oldSel.value));
  const newSel = meshOptions();
  newSel.value = state.newHash;
  newSel.addEventListener('change', () => (state.newHash = newSel.value));

  const fileInput = el('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void uploadMesh(f);
  });

  return el('section', { class: 'panel' }, [
    el('h2', { text: '1 · 选择两个不可变网格版本' }),
    el('div', { class: 'row' }, [
      el('div', {}, [el('div', { class: 'small', text: '旧网格（来源）' }), oldSel]),
      el('div', { style: 'font-size:18px;color:var(--muted)', text: '→' }),
      el('div', {}, [el('div', { class: 'small', text: '新网格（目标）' }), newSel]),
      el('button', {
        class: 'primary',
        text: '生成迁移预览',
        onclick: () => void createPlan()
      }),
      el('div', { style: 'flex:1' }),
      fileInput
    ]),
    el('p', { class: 'small', text: '可上传其它 JSON 网格；fixture 已在启动时自动入库。' })
  ]);
}

function renderTopologyDiff(): HTMLElement {
  const d = state.plan!.topologyDiff;
  const stat = (label: string, oldN: number, newN: number) =>
    el('div', { class: 'diff-stat' }, [
      el('span', { text: label }),
      el('b', { text: `${oldN} → ${newN}` })
    ]);

  const hashLine = (label: string, id: string, hash: string) =>
    el('div', { class: 'hash' }, [
      el('span', { text: `${label} ${id}  ` }),
      el('code', { text: hash })
    ]);

  return el('section', { class: 'panel' }, [
    el('h2', { text: '2 · 拓扑差异与几何距离' }),
    el('div', { class: 'grid cards' }, [
      el('div', {}, [
        stat('节点 Nodes', d.oldNodes!, d.newNodes!),
        stat('边 Edges', d.oldEdges!, d.newEdges!),
        stat('面 Faces', d.oldFaces!, d.newFaces!),
        stat('单元 Elements', d.oldElements!, d.newElements!)
      ]),
      el('div', {}, [
        el('div', { class: 'diff-stat' }, [
          el('span', { text: '保留的边（拓扑键相同）' }),
          el('b', { text: String(d.sharedEdges) })
        ]),
        hashLine('旧', state.plan!.oldMeshId, state.plan!.oldHash),
        hashLine('新', state.plan!.newMeshId, state.plan!.newHash),
        el('div', { class: 'small', style: 'margin-top:6px', text: '预览基于以上两个哈希冻结；提交时会重新哈希检查版本是否过期。' })
      ])
    ])
  ]);
}

const STATUS_LABEL: Record<string, string> = {
  complete: '完全',
  split: '拆分',
  merged: '合并',
  ambiguous: '歧义',
  unmatched: '无对应/拒绝',
  disabled: '已禁用',
  rebuild: '需重建'
};

function renderRows(): HTMLElement {
  const rows = state.plan!.rows;
  const panel = el('section', { class: 'panel' }, [
    el('h2', { text: '3 · 工程对象迁移预览与候选对应' })
  ]);
  const table = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '对象' }),
        el('th', { text: '判定' }),
        el('th', { text: '候选 / 保守量' }),
        el('th', { text: '人工操作' })
      ])
    ])
  ]);
  const tbody = el('tbody');
  for (const row of rows) tbody.appendChild(renderRow(row));
  table.appendChild(tbody);
  panel.appendChild(table);
  return panel;
}

function renderRow(row: PlanRow): HTMLElement {
  const kindLabel: Record<string, string> = {
    facePressure: '面载荷',
    nodalForce: '节点力',
    constraint: '固定约束',
    probe: '探针',
    zone: '材料分区'
  };

  const badge = el('span', {
    class: `badge ${row.status}`,
    text: STATUS_LABEL[row.status] ?? row.status
  });
  const reasons = el('ul', { class: 'reasons' }, row.reasons.map((r) => el('li', { text: r })));

  const middle = el('div');
  if (row.kind === 'facePressure') {
    middle.appendChild(
      el('div', { class: 'small', text: `覆盖率 ${((row.coverage ?? 0) * 100).toFixed(2)}% · ${row.proposed?.length ?? 0} 个新面` })
    );
    const c = row.conservation;
    if (c) {
      middle.appendChild(
        el('div', { class: `small ${c.forceOk ? 'metric-good' : 'metric-bad'}` }, [
          el('span', { text: `合力 |ΔF|=${c.forceError.toExponential(2)} ` }),
          el('span', { text: c.forceOk ? '✓ 守恒' : '✗ 超差' })
        ])
      );
      middle.appendChild(
        el('div', { class: `small ${c.momentOk ? 'metric-good' : 'metric-bad'}` }, [
          el('span', { text: `合力矩 |ΔM|=${c.momentError.toExponential(2)} ` }),
          el('span', { text: c.momentOk ? '✓ 守恒' : '✗ 超差' })
        ])
      );
    }
  }
  if ((row.kind === 'nodalForce' || row.kind === 'constraint' || row.kind === 'probe') && row.newNode) {
    middle.appendChild(el('div', { class: 'small mono', text: `→ ${row.newNode}` }));
  }
  if (row.kind === 'zone') {
    middle.appendChild(el('div', { class: 'small', text: `${row.newElementIds?.length ?? 0} 个新单元继承该分区` }));
  }

  if (row.candidates.length > 0) {
    const det = el('details', {}, [
      el('summary', { text: `${row.candidates.length} 个候选对应（几何证据）` }),
      el(
        'div',
        { class: 'candidates' },
        row.candidates.slice(0, 12).map((c) =>
          el('div', { class: 'candidate' }, [
            el('button', {
              class: 'ghost',
              style: 'padding:2px 8px',
              text: '确认',
              title: '将此候选作为新证据',
              onclick: () => void decide(row, 'confirm', c.target)
            }),
            el('span', { text: `${c.target} — ${c.detail}` })
          ])
        )
      )
    ]);
    middle.appendChild(det);
  }

  const frozen = state.planStatus === 'accepted';
  const actions = el('div', { class: 'pill-group' }, [
    el('button', {
      class: 'ghost',
      text: '禁用',
      disabled: frozen ? 'true' : 'false',
      onclick: () => void decide(row, 'disable')
    }),
    el('button', {
      class: 'ghost',
      text: '标记重建',
      disabled: frozen ? 'true' : 'false',
      onclick: () => void decide(row, 'rebuild')
    }),
    el('button', {
      class: 'ghost',
      text: '重置为机判',
      disabled: frozen ? 'true' : 'false',
      onclick: () => void decide(row, 'reset')
    })
  ]);

  return el('tr', {}, [
    el('td', {}, [
      el('div', { class: 'kind', text: kindLabel[row.kind] ?? row.kind }),
      el('div', { text: row.label }),
      reasons
    ]),
    el('td', {}, [badge]),
    el('td', {}, [middle]),
    el('td', {}, [actions])
  ]);
}

function renderFooter(): HTMLElement {
  const counts = state.plan!.rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const blocked = ['ambiguous', 'unmatched', 'disabled', 'rebuild']
    .map((s) => counts[s] ?? 0)
    .reduce((a, b) => a + b, 0);

  return el('section', { class: 'panel row spread' }, [
    el('div', { class: 'small' }, [
      el('span', {
        text: `共 ${state.plan!.rows.length} 个对象 · 完全 ${counts.complete ?? 0} · 拆分 ${counts.split ?? 0} · 合并 ${counts.merged ?? 0} · 阻塞 ${blocked}`
      })
    ]),
    el('div', { class: 'row' }, [
      el('a', { href: api.exportUrl(state.plan!.planId), target: '_blank' }, [
        el('button', { class: 'ghost', text: '导出已接受结果' })
      ]),
      el('button', {
        class: 'primary',
        text: state.planStatus === 'accepted' ? '已冻结提交' : '事务提交',
        disabled: state.planStatus === 'accepted' ? 'true' : 'false',
        onclick: () => void commit()
      })
    ])
  ]);
}

void refreshMeshes();
