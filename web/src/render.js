import { state, setSelection, createPlan, addEvidence, acceptPlan } from './main.js';

const RELATION_LABEL = {
  complete: '完整', split: '拆分', merge: '合并', ambiguous: '歧义',
  removed: '无对应', new: '新增', partial: '部分', manual: '人工',
  rejected: '拒绝', rebuild: '重建', disabled: '禁用', confirmed: '已确认', auto: '自动',
};

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function badge(rel) {
  const cls = `b-${rel}`;
  return `<span class="badge ${cls}">${RELATION_LABEL[rel] ?? rel}</span>`;
}
function vec(v, d = 4) {
  return Array.isArray(v) ? `[${v.map((x) => Number(x).toFixed(d)).join(', ')}]` : esc(v);
}

export function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  app.append(header());
  const main = el('<main></main>');
  main.append(versionPicker());
  if (state.error) main.append(el(`<div class="banner bad">${esc(state.error)}</div>`));
  if (state.plan) main.append(...planPanels());
  app.append(main);
  bind();
}

function header() {
  return el(`<header>
    <h1>有限元网格版本迁移</h1>
    <span class="sub">节点 / 边 / 面 / 单元对应 · 守恒量校验 · 人工证据</span>
  </header>`);
}

function versionPicker() {
  const card = el('<section class="card"></section>');
  card.append(el('<h2>1. 选择两个不可变网格版本</h2>'));
  const groups = groupBySeries(state.meshes);
  const options = (sel) => state.meshes.map((m) =>
    `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.series)} v${m.version} · ${esc(m.name)}${m.stale ? '（已过期）' : ''}</option>`).join('');
  card.append(el(`<div class="grid2">
    <label>旧网格（源）<br/><select id="sel-from">${options(state.fromId)}</select></label>
    <label>新网格（目标）<br/><select id="sel-to">${options(state.toId)}</select></label>
  </div>`));
  const btnRow = el('<div class="row" style="margin-top:12px"></div>');
  const btn = el('<button class="primary">生成迁移预览</button>');
  btn.id = 'btn-preview';
  const note = el('<span class="muted">预览会冻结全部数值容差；之后修改默认值不会重写该计划。</span>');
  btnRow.append(btn, note);
  card.append(btnRow);
  return card;
}

function groupBySeries(meshes) {
  const map = new Map();
  for (const m of meshes) {
    if (!map.has(m.series)) map.set(m.series, []);
    map.get(m.series).push(m);
  }
  return map;
}

function planPanels() {
  const p = state.plan;
  const pv = p.preview;
  const panels = [];
  const meta = el(`<section class="card">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">迁移计划 <span class="mono">${esc(p.id.slice(0, 8))}</span></h2>
      ${badge(p.status)}
    </div>
    <div class="hash" style="margin-top:6px">
      旧哈希 ${esc(p.fromHash.slice(0, 16))}… → 新哈希 ${esc(p.toHash.slice(0, 16))}…
    </div>
  </section>`);
  panels.push(meta);

  if (pv.blocked) {
    const b = el('<section class="card"></section>');
    b.append(el('<h2>网格校验未通过，迁移被阻止</h2>'));
    b.append(issuesTable(pv.oldValidation, '旧网格'));
    b.append(issuesTable(pv.newValidation, '新网格'));
    panels.push(b);
    return panels;
  }

  panels.push(topologyPanel());
  panels.push(distancePanel());
  panels.push(correspondencePanel());
  panels.push(objectsPanel());
  panels.push(setsPanel());
  panels.push(regionsPanel());
  panels.push(evidencePanel());
  panels.push(submitPanel());
  return panels;
}

function issuesTable(issues, title) {
  const wrap = el('<div style="margin-bottom:10px"></div>');
  if (!issues.length) return wrap;
  wrap.append(el(`<h3>${title}（${issues.length} 项）</h3>`));
  const rows = issues.map((i) => `<tr>
      <td><span class="badge b-${i.severity}">${i.severity === 'error' ? '错误' : '警告'}</span></td>
      <td class="mono">${esc(i.code)}</td><td>${esc(i.message)}</td>
    </tr>`).join('');
  wrap.append(el(`<table><thead><tr><th>级别</th><th>规则</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>`));
  return wrap;
}

function topologyPanel() {
  const t = state.plan.preview.topology;
  const card = el('<section class="card"></section>');
  card.append(el('<h2>2. 拓扑差异</h2>'));
  const cell = (label, row) => `<tr><td>${label}</td>
    <td>${row.complete}</td><td>${row.split}</td><td>${row.merge}</td>
    <td>${row.ambiguous}</td><td>${row.removed}</td><td>${row.added}</td></tr>`;
  card.append(el(`<table>
    <thead><tr><th></th><th>完整</th><th>拆分</th><th>合并</th><th>歧义</th><th>无对应（旧）</th><th>新增（新）</th></tr></thead>
    <tbody>${cell('节点', t.nodes)}${cell('边', t.edges)}${cell('面', t.faces)}${cell('单元', t.cells)}</tbody>
  </table>`));
  return card;
}

function distancePanel() {
  const d = state.plan.preview.distances;
  const card = el('<section class="card"></section>');
  card.append(el('<h2>3. 几何距离</h2>'));
  card.append(el(`<p class="section-note">节点对距离按容差配对；面对使用对称 Hausdorff 距离（m）。一对多/无对应不会被最近邻强行配对。</p>`));
  const stats = `<table><tbody>
    <tr><td>配对节点</td><td>${d.node.matched}</td></tr>
    <tr><td>最大节点距离</td><td class="mono">${d.node.max.toExponential(3)} m</td></tr>
    <tr><td>平均节点距离</td><td class="mono">${d.node.mean.toExponential(3)} m</td></tr>
    <tr><td>消失节点</td><td>${d.node.removed.length ? esc(d.node.removed.join(', ')) : '—'}</td></tr>
    <tr><td>新增节点</td><td>${d.node.added.length ? `${d.node.added.length} 个` : '—'}</td></tr>
  </tbody></table>`;
  card.append(el(`<div class="grid2"><div>${stats}</div><div>${faceDistTable(d.face)}</div></div>`));
  return card;
}
function faceDistTable(rows) {
  const body = rows.slice(0, 30).map((r) => `<tr>
    <td>${badge(r.relation)}</td>
    <td class="mono">${esc(r.oldIds.join(','))} → ${esc(r.newIds.join(','))}</td>
    <td class="mono">${r.hausdorff.toExponential(2)}</td></tr>`).join('');
  return `<h3>面对 Hausdorff 距离（前 30 组）</h3>
    <table><thead><tr><th>关系</th><th>面</th><th>距离 m</th></tr></thead><tbody>${body || '<tr><td colspan=3 class=muted>无</td></tr>'}</tbody></table>`;
}

function correspondencePanel() {
  const c = state.plan.preview.correspondence;
  const card = el('<section class="card"></section>');
  card.append(el('<h2>4. 候选对应</h2>'));
  const groups = (title, list) => {
    const body = list.map((g) => `<tr><td>${badge(g.relation)}</td>
      <td class="mono">${esc(g.oldIds.join(', ') || '—')}</td>
      <td class="mono">${esc(g.newIds.join(', ') || '—')}</td></tr>`).join('');
    return `<details ${list.some((g) => ['ambiguous', 'removed', 'new'].includes(g.relation)) ? 'open' : ''}>
      <summary>${title}（${list.length} 组）</summary>
      <table><thead><tr><th>关系</th><th>旧</th><th>新</th></tr></thead><tbody>${body}</tbody></table></details>`;
  };
  card.append(el(`<div class="grid2">
    <div>${groups('面分组', c.faceGroups)}</div>
    <div>${groups('单元分组', c.cellGroups)}${groups('边分组', c.edgeGroups)}</div>
  </div>`));
  return card;
}

function objectsPanel() {
  const objs = state.plan.applied.objects;
  const card = el('<section class="card"></section>');
  card.append(el('<h2>5. 迁移预览：工程对象</h2>'));
  card.append(el('<p class="section-note">每行给出结论与理由；拆分载荷列出面积权重与合力/力矩检查。可对单行人工确认、禁用或标记重建。</p>'));
  const body = objs.map((r, i) => {
    const checks = (r.checks ?? []).map((c) => {
      const val = c.code === 'FORCE' ? `合力 Δ=${c.diff.toExponential(2)} N`
        : c.code === 'MOMENT' ? `力矩 Δ=${c.diff.toExponential(2)} N·m`
        : c.code === 'AREA' ? `面积 Δ=${c.diff.toExponential(2)} m²` : `${c.code} Δ=${c.diff}`;
      return `<li class="${c.passed ? 'check-pass' : 'check-fail'}">${c.passed ? '✓' : '✗'} ${val}（容差 ${Number(c.tolerance).toExponential(1)}）</li>`;
    }).join('');
    const loads = (r.loads ?? []).length ? `<details><summary>${r.loads.length} 个目标面的权重</summary>
      <table><thead><tr><th>面</th><th>面积 m²</th><th>权重</th></tr></thead><tbody>
      ${r.loads.map((l) => `<tr><td class=mono>${esc(l.faceId)}</td><td>${l.area.toFixed(6)}</td><td>${l.weight.toFixed(4)}</td></tr>`).join('')}
      </tbody></table></details>` : '';
    const stateLabel = badge(r.finalState);
    return `<tr>
      <td><div class="mono">${esc(r.objectId)}</div><div class="muted">${esc(typeLabel(r.objectType))}</div></td>
      <td>${badge(r.decision)} ${r.finalState !== 'auto' && r.finalState !== r.decision ? stateLabel : ''}</td>
      <td>${esc(r.reason)}${r.nearest ? `<div class="muted">最近点 ${esc(r.nearest.nodeId)}：${r.nearest.distance.toExponential(2)} m（不自动归属）</div>` : ''}
          ${checks ? `<ul style="margin:6px 0 0;padding-left:16px">${checks}</ul>` : ''}${loads}</td>
      <td>${evidenceButtons(r, i)}</td>
    </tr>`;
  }).join('');
  card.append(el(`<table><thead><tr><th>对象</th><th>结论</th><th>理由 / 保守量</th><th>人工证据</th></tr></thead><tbody>${body}</tbody></table>`));
  return card;
}

function typeLabel(t) {
  return { constraint: '节点约束', traction: '面载荷', probe: '探针' }[t] ?? t;
}

function evidenceButtons(r, i) {
  const disabled = state.plan.status === 'accepted';
  const cur = r.evidence?.action;
  const btn = (action, cls, label) => `<button class="${cls}" data-evidence="${action}" data-index="${i}" ${disabled || cur === action ? 'disabled' : ''}>${label}</button>`;
  return `<div class="row">${btn('confirm', 'confirm', '确认')}${btn('disable', 'disable', '禁用')}${btn('rebuild', 'rebuild', '重建')}</div>`;
}

function setsPanel() {
  const sets = state.plan.applied.sets;
  const card = el('<section class="card"></section>');
  card.append(el('<h2>6. 边界区域（集合语义）</h2>'));
  card.append(el('<p class="section-note">先删除再重建保持稳定 id 与导出顺序；成员去重，丢弃成员明确列出。</p>'));
  const body = sets.map((s, i) => `<tr>
    <td class="mono">${esc(s.setId)}</td><td>${badge(s.decision)}</td>
    <td>${esc(s.reason)}<div class="muted">成员 ${s.members.length} 个${s.dropped.length ? `；丢弃 ${s.dropped.length} 个：${esc(s.dropped.map((d) => `${d.kind}:${d.id}`).join(', '))}` : ''}</div></td>
    <td>${evidenceButtons({ evidence: s.evidence }, 1000 + i)
      .replace(/data-index="\d+"/, `data-kind="set" data-index="${1000 + i}"`)}</td>
  </tr>`).join('');
  card.append(el(`<table><thead><tr><th>集合 id</th><th>结论</th><th>理由</th><th>人工证据</th></tr></thead><tbody>${body}</tbody></table>`));
  return card;
}

function regionsPanel() {
  const regions = state.plan.applied.regions;
  const card = el('<section class="card"></section>');
  card.append(el('<h2>7. 材料分区</h2>'));
  const body = regions.map((r, i) => `<tr>
    <td><div class="mono">${esc(r.regionId)}</div><div class="muted">${esc(r.material)}</div></td>
    <td>${badge(r.decision)}</td>
    <td>${esc(r.reason)}${r.conflicts.length ? `<div class="issue-error">冲突单元：${esc(r.conflicts.join(', '))}</div>` : ''}</td>
    <td>${evidenceButtons({ evidence: r.evidence }, 2000 + i)
      .replace(/data-index="\d+"/, `data-kind="region" data-index="${2000 + i}"`)}</td>
  </tr>`).join('');
  card.append(el(`<table><thead><tr><th>分区</th><th>结论</th><th>理由</th><th>人工证据</th></tr></thead><tbody>${body}</tbody></table>`));
  return card;
}

function evidencePanel() {
  const list = state.plan.evidence ?? [];
  const card = el('<section class="card"></section>');
  card.append(el('<h2>8. 人工证据（只追加、作为新证据保存）</h2>'));
  if (!list.length) {
    card.append(el('<p class="muted">暂无人工证据；自动结论来自几何与拓扑证据。</p>'));
    return card;
  }
  const body = list.map((e) => `<tr>
    <td class="mono">${esc(e.created_at)}</td>
    <td>${esc(typeLabel(e.object_type) || e.object_type)}</td>
    <td class="mono">${esc(e.object_id)}</td>
    <td>${badge(e.action === 'confirm' ? 'confirmed' : e.action)}</td>
    <td>${esc(e.note ?? '')}</td><td class="muted">${esc(e.author)}</td>
  </tr>`).join('');
  card.append(el(`<table><thead><tr><th>时间</th><th>类型</th><th>对象</th><th>动作</th><th>备注</th><th>来源</th></tr></thead><tbody>${body}</tbody></table>`));
  return card;
}

function submitPanel() {
  const a = state.plan.applied;
  const card = el('<section class="card"></section>');
  card.append(el('<h2>9. 提交</h2>'));
  const frozen = Object.entries(state.plan.tolerances).map(([k, v]) => `<span class="pill">${k}=${Number(v).toExponential(0)}</span>`).join(' ');
  card.append(el(`<div class="muted" style="margin-bottom:8px">冻结容差：${frozen}</div>`));
  if (a.blocking.length) {
    card.append(el(`<div class="banner bad">存在 ${a.blocking.length} 项阻塞，不能提交：<ul style="margin:6px 0 0">${a.blocking.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`));
  } else {
    card.append(el('<div class="banner ok">所有对象要么已迁移且保守量通过，要么被标记重建/禁用。可以提交。</div>'));
  }
  const row = el('<div class="row"></div>');
  const accepted = state.plan.status === 'accepted';
  const btn = el(`<button class="primary" ${accepted || a.blocking.length ? 'disabled' : ''}>${accepted ? '已接受（不可变）' : '事务提交迁移'}</button>`);
  btn.id = 'btn-accept';
  row.append(btn);
  if (accepted) {
    const dl = el(`<a href="/api/plans/${state.plan.id}/export"><button>下载导出 JSON</button></a>`);
    row.append(dl);
  }
  card.append(row);
  return card;
}

function bind() {
  const from = document.getElementById('sel-from');
  const to = document.getElementById('sel-to');
  from?.addEventListener('change', () => setSelection('from', from.value));
  to?.addEventListener('change', () => setSelection('to', to.value));
  document.getElementById('btn-preview')?.addEventListener('click', async () => {
    try {
      state.error = null;
      await createPlan({});
      render();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });
  document.getElementById('btn-accept')?.addEventListener('click', async () => {
    try {
      await acceptPlan();
      render();
    } catch (err) {
      state.error = `${err.message}${err.data?.blocking ? '：' + err.data.blocking.join('；') : ''}`;
      render();
    }
  });
  document.querySelectorAll('[data-evidence]').forEach((node) => {
    node.addEventListener('click', async () => {
      const action = node.dataset.evidence;
      const kind = node.dataset.kind;
      const applied = state.plan.applied;
      let objectType, objectId;
      if (kind === 'set') {
        objectType = 'set';
        objectId = applied.sets[node.dataset.index - 1000].setId;
      } else if (kind === 'region') {
        objectType = 'region';
        objectId = applied.regions[node.dataset.index - 2000].regionId;
      } else {
        const r = applied.objects[node.dataset.index];
        objectType = r.objectType;
        objectId = r.objectId;
      }
      const note = { confirm: '工程师手工确认该对应', disable: '工程师禁用该对象迁移', rebuild: '工程师标记该对象需要在新网格上重建' }[action];
      try {
        await addEvidence({ objectType, objectId, action, note });
        state.error = null;
        render();
      } catch (err) {
        state.error = err.message;
        render();
      }
    });
  });
}
