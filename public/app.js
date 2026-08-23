'use strict';
/* Agent Board 前端 v4：session 卡片 + 直连跳转 + 顶栏快捷图标 + 活跃时长统计 */

const state = {
  agents: [], projects: [], active: [], agentsDef: {},
  project: '', q: '', range: 0, activeRange: 'day', activeProject: '',
  onlyUser: true,
  board: {}, agentIds: [], defaultAgentIds: [], colOrder: null,
  // 实时活跃会话集合：由 SSE active 事件维护，渲染状态唯一权威来源
  liveRefs: new Set(),
  // 「刚完成」标记：ref -> completedAt ts（绿色流光），由 SSE 捕捉 进行中→已完成 迁移写入
  recentDone: new Map(),
  // 用户手动点「已读」取消高亮的 ref 集合（localStorage 持久化，避免刷新后重新点亮）
  dismissedRecent: new Set(),
  loading: false,
  stats: { total: 0, today: 0, active: 0 },
  popoverFor: null,
};

// 瀑布流列配置：localStorage 持久化（显示哪些 agent 列 + 顺序），null 表示用默认
function loadColOrder() {
  try { return JSON.parse(localStorage.getItem('ab-cols')); } catch { return null; }
}
function saveColOrder(order) {
  localStorage.setItem('ab-cols', JSON.stringify(order));
}
// 有效列 = 配置顺序 ∩ 实际存在的 agent（防止配置了不存在的列）
function effectiveCols() {
  // colOrder 为 null（默认模式）时的候选列表用 defaultAgentIds（已安装/有历史数据过滤后的子集），
  // 不用全集 state.agentIds——这两行只在「默认视图」语境下才会被用到，要和 loadBoard()/
  // 「恢复默认」按钮保持同一套过滤规则，否则会出现短暂的过滤失效（见代码审查记录）。
  const def = state.colOrder || ['all', ...state.defaultAgentIds];
  // valid 集合必须用全集 state.agentIds：这里是「配置的列是否真实存在」的完整性校验，
  // 不是默认视图过滤，用户手动保存过的列（哪怕是被默认视图隐藏的 agent）也不该被判定无效。
  const valid = new Set(['all', ...state.agentIds]);
  const out = def.filter((c) => valid.has(c));
  // 只在默认模式（colOrder 为 null，用户从未手动配置）下自动补全新出现的 agent；
  // 一旦用户通过列设置保存过 colOrder，就完全尊重用户的选择（隐藏的列不补回）。
  if (!state.colOrder) {
    for (const id of state.defaultAgentIds) if (!out.includes(id)) out.push(id);
  }
  return out;
}

const $ = (id) => document.getElementById(id);
// HTML 转义：卡片/标题/消息文本含引号、尖括号时防止破坏 DOM 结构（Marvis 定时任务标题等）
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
// 精简标题：取文本清理后的前 N 字（抽屉锚点用）
function smartTitle(text, max = 40) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : '';
}
const clip = (txt) => navigator.clipboard.writeText(txt).then(() => true, () => false);

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtTimeLabel(ts) {
  // 会话卡 s-time 显示：今天/昨天 → "今天 09:11" / "昨天 09:11"；更早 → "MM-DD HH:MM" / "YYYY-MM-DD HH:MM"
  const d = new Date(ts);
  const n = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay(d, n)) return `今天 ${t}`;
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (sameDay(d, y)) return `昨天 ${t}`;
  const sameYear = d.getFullYear() === n.getFullYear();
  const dateStr = sameYear
    ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${dateStr} ${t}`;
}
function dayLabel(ts, now) {
  const d = new Date(ts);
  const n = new Date(now);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, n)) return '今天';
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (same(d, y)) return '昨天';
  const sameYear = d.getFullYear() === n.getFullYear();
  return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function ago(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}
function fmtDayFull(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtClock(ts)}`;
}

/* ---------- 数据加载 ---------- */
async function loadState() {
  try {
    const r = await fetch('/api/state?range=' + state.activeRange);
    const d = await r.json();
    state.agents = d.agents; state.projects = d.projects; state.active = d.active;
    state.agentsDef = d.agentsDef || {};
    state.stats = d.stats;
    renderChips(); renderProjects(); renderStats(); renderQuickAgents(); renderActive();
  } catch { /* 服务未启动 */ }
}

async function loadBoard() {
  if (state.loading) return;
  state.loading = true;
  try {
    const params = new URLSearchParams({ limit: 80 });
    if (state.project) params.set('project', state.project);
    if (state.q) params.set('q', state.q);
    if (state.range) params.set('range', String(state.range));
    if (state.onlyUser) params.set('onlyUser', '1');
    const r = await fetch('/api/board?' + params);
    const d = await r.json();
    state.board = d.groups || state.board;
    state.agentIds = d.agentIds || [];
    // defaultAgentIds：探测为已安装 或 有历史数据的 agent 子集，只用来算「默认列」，
    // 不影响 state.agentIds（列设置弹窗仍然要能看到全部 agent，供手动勾选恢复）
    state.defaultAgentIds = d.defaultAgentIds || d.agentIds || [];
    // 后端返回的实时活跃集合：只并入不覆盖——移除动作完全由 SSE active 事件权威执行，
    // 避免 loadBoard 重建时（即使后端快照 status 恰好过期）把进行中会话闪回「已完成」
    if (Array.isArray(d.liveRefs)) {
      const next = new Set(d.liveRefs);
      for (const r of state.liveRefs) next.add(r);
      state.liveRefs = next;
    }
    // 首次加载：把当前配置的列存好（默认 = all + 探测/历史数据过滤后的 agent）
    if (!state.colOrder) state.colOrder = loadColOrder() || ['all', ...state.defaultAgentIds];
    renderBoard();
  } catch { /* 网络错误忽略 */ }
  finally { state.loading = false; }
}

/* ---------- 顶栏 AI Agent 快捷图标 ---------- */
function renderQuickAgents() {
  const box = $('quick-agents'); box.innerHTML = '';
  const defs = state.agentsDef || {};
  for (const id of Object.keys(defs)) {
    const def = defs[id];
    const btn = document.createElement('button');
    btn.className = 'qa-btn';
    btn.title = def.name + '（点击：未运行则启动，已运行则跳转）';
    const letter = def.name.replace(/[^A-Za-z\u4e00-\u9fff]/g, '').slice(0, 1) || '?';
    if (def.icon) {
      btn.innerHTML = `<img src="/icons/${esc(def.icon)}" alt="">`;
    } else {
      btn.innerHTML = `<span class="qb" style="background:${def.color}">${esc(letter)}</span>`;
    }
    btn.onclick = () => launchAgent(id);
    box.appendChild(btn);
  }
}

async function launchAgent(agent) {
  const def = state.agentsDef[agent];
  const name = def ? def.name : agent;
  toast(`正在处理 ${name}…`);
  try {
    const res = await fetch('/api/launch-agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent }),
    });
    const d = await res.json();
    if (d.ok) { toast(`${name}：已运行则跳转，未运行已启动`); }
    else toast(`${name}：${d.error || '操作失败'}`);
  } catch { toast('请求失败'); }
  // 延迟刷新运行状态标记
  setTimeout(refreshRunStatus, 1200);
}
async function refreshRunStatus() {
  try {
    const r = await fetch('/api/state?range=' + state.activeRange);
    const d = await r.json();
    state.stats = d.stats;
    renderStats();
  } catch { /* ignore */ }
}

/* ---------- 渲染：统计 / 筛选 / 活跃区 ---------- */
function renderStats() {
  $('st-today').textContent = state.stats.today ?? 0;
  $('st-total').textContent = state.stats.total ?? 0;
  $('st-active').textContent = state.stats.active ?? 0;
}
function renderChips() {
  // 6 列瀑布流自带 agent 维度，chips 仅做统计展示（不再影响列表内容）
  const box = $('agent-chips'); box.innerHTML = '';
  const cnt = { all: 0 };
  for (const s of [...state.board.all]) cnt.all++;
  for (const a of state.agents) cnt[a.id] = state.board[a.id] ? state.board[a.id].length : 0;
  const all = document.createElement('button');
  all.className = 'chip on';
  all.textContent = '全部';
  box.appendChild(all);
  for (const a of state.agents) {
    const c = document.createElement('button');
    c.className = 'chip';
    c.innerHTML = `<span class="dot" style="background:${a.color}"></span>${esc(a.name)} <span style="opacity:.55">${cnt[a.id]}</span>`;
    box.appendChild(c);
  }
}
function renderProjects() {
  // 同一份项目列表驱动两个筛选器（顶部时间线筛选 + 活跃区筛选），互不干扰各自的状态
  for (const sel of [$('f-project'), $('active-project')]) {
    const keep = sel.id === 'f-project' ? state.project : state.activeProject;
    sel.innerHTML = '<option value="">全部项目</option>';
    for (const p of state.projects) {
      const o = document.createElement('option');
      o.value = p.project; o.textContent = `${p.project} (${p.cnt})`;
      sel.appendChild(o);
    }
    sel.value = keep;
  }
}
const RANGE_LABEL = { day: '当天', '24h': '近 24 小时', week: '近一周', month: '近一个月' };
function renderActive() {
  const row = $('active-row'); const title = $('active-title');
  row.innerHTML = '';
  let list = state.active || [];
  if (state.activeProject) list = list.filter((a) => a.project === state.activeProject);
  if (state.onlyUser) list = list.filter((a) => a.has_user);
  title.style.display = list.length ? 'flex' : 'none';
  $('active-label').textContent = `${RANGE_LABEL[state.activeRange] || '当天'}活跃的会话`;
  $('active-note').textContent = list.length ? `${list.length} 个` : '';
  for (const a of list) {
    const def = state.agentsDef[a.agent] || {};
    const meta = { name: def.name || a.agent, color: def.color || '#888780' };
    const card = document.createElement('div');
    card.className = 'a-card';
    card.innerHTML = `
      <div class="top"><span class="a-dot" style="background:${meta.color}"></span>
      <span class="a-name">${esc(meta.name)}</span><span class="ago">${ago(a.lastActivity)}</span></div>
      <div class="proj" title="${esc(a.title || '')}">${esc(a.title || (a.project || '（未记录项目）'))}</div>
      ${a.live ? '<span class="live"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>进行中</span>'
               : `<span style="font-size:11px;color:var(--text3)">${esc(a.project || '')}</span>`}`;
    card.onclick = () => openSession(a.sessionRef);
    row.appendChild(card);
  }
}

/* ---------- 渲染：按 session 卡片 ---------- */
function agentMeta(id) { const d = state.agentsDef[id] || {}; return { name: d.name || id, color: d.color || '#888780' }; }
function shortProj(p) { if (!p) return ''; return p.length > 60 ? '…' + p.slice(-58) : p; }
function resumeCommand(agent, sid) {
  if (agent === 'claude') return `claude --resume ${sid}`;
  if (agent === 'codex') return `codex resume ${sid}`;
  return '';
}
// 从 board 各组移除指定 session
function removeFromBoard(b, agent, sessionId) {
  const ref = agent + ':' + sessionId;
  const out = {};
  for (const k of Object.keys(b)) out[k] = (b[k] || []).filter((s) => s.id !== ref);
  return out;
}

/* ---------- 「刚完成」流光标记 ---------- */
// 会话刚离开活跃窗口（进行中 → 已完成）时打绿色流光 + 「已读」按钮；
// 点击「已读」→ 恢复普通已完成样式；超过 TTL 自动取消。localStorage 持久化。
const RECENT_DONE_TTL = 30 * 60 * 1000; // 高亮保留时长：30 分钟
function loadRecentDone() {
  try {
    const raw = JSON.parse(localStorage.getItem('ab-recent-done') || '{}');
    const now = Date.now();
    for (const k of Object.keys(raw)) if (now - raw[k] < RECENT_DONE_TTL) state.recentDone.set(k, raw[k]);
  } catch {}
  try { state.dismissedRecent = new Set(JSON.parse(localStorage.getItem('ab-recent-dismissed') || '[]')); } catch {}
}
function persistRecentDone() {
  try {
    const obj = {}; for (const [k, v] of state.recentDone) obj[k] = v;
    localStorage.setItem('ab-recent-done', JSON.stringify(obj));
    localStorage.setItem('ab-recent-dismissed', JSON.stringify([...state.dismissedRecent]));
  } catch {}
}
function isRecentCompleted(ref) {
  const t = state.recentDone.get(ref);
  if (!t || state.dismissedRecent.has(ref)) return false;
  if (Date.now() - t > RECENT_DONE_TTL) { state.recentDone.delete(ref); persistRecentDone(); return false; }
  return true;
}
function markRecentlyCompleted(ref) {
  state.dismissedRecent.delete(ref); // 新一轮完成重新点亮，忽略之前的「已读」
  state.recentDone.set(ref, Date.now());
  persistRecentDone();
}
function dismissRecent(ref) {
  state.recentDone.delete(ref);
  state.dismissedRecent.add(ref);
  persistRecentDone();
}
// 按最新状态刷新单张卡的流光装饰（SSE 逐卡差异更新 + 已读点击共用）
function applyFlowDecor(el, ref, nowLive) {
  const recent = !nowLive && isRecentCompleted(ref);
  el.classList.toggle('flow-red', nowLive);
  el.classList.toggle('flow-green', recent);
  let btn = el.querySelector('.s-flow-dismiss');
  if (recent && !btn) {
    btn = document.createElement('button');
    btn.className = 's-flow-dismiss';
    btn.title = '取消「刚完成」流光高亮，恢复普通已完成样式';
    btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>已读';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissRecent(ref);
      syncFlowDecor(ref);
      toast('已恢复普通已完成样式');
    });
    const more = el.querySelector('.s-more');
    (more ? more.parentElement : el).insertBefore(btn, more);
  } else if (!recent && btn) {
    btn.remove();
  }
}
// 同一会话会在「全部」列和 agent 列各出现一次，同步所有列的流光装饰
function syncFlowDecor(ref) {
  document.querySelectorAll('#board .s-card').forEach((el) => {
    const r = el.querySelector('.s-more')?.dataset.ref;
    if (r === ref) applyFlowDecor(el, r, state.liveRefs.has(r));
  });
}

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  const cols = effectiveCols();
  // 聚焦列：被点击的列加宽，其他列缩小
  const focused = state.focusedCol;
  board.classList.toggle('has-focus', !!focused);
  board.style.gridTemplateColumns = cols.map((c) => {
    if (!focused) return 'minmax(0, 1fr)';
    if (c === focused) return 'minmax(320px, 2.2fr)';
    return 'minmax(0, 0.55fr)';
  }).join(' ');
  for (const key of cols) {
    const col = document.createElement('div');
    col.className = 'agent-col' + (key === focused ? ' focused' : '');
    col.dataset.col = key;
    const meta = key === 'all' ? { name: '全部', color: '#888780', icon: null } : (state.agentsDef[key] || { name: key, color: '#888780', icon: null });
    const head = document.createElement('div');
    head.className = 'col-head';
    head.style.setProperty('--colc', meta.color);
    const focusIcon = key === focused ? '<span class="col-focus-ic" title="已聚焦，点击取消">▣</span>' : '<span class="col-focus-ic" title="点击聚焦此列">▢</span>';
    head.innerHTML = `<span class="col-name">${esc(meta.name)}</span>${focusIcon}`;
    head.querySelector('.col-name').onclick = () => toggleFocus(key);
    head.querySelector('.col-focus-ic').onclick = (e) => { e.stopPropagation(); toggleFocus(key); };
    const cardsBox = document.createElement('div');
    cardsBox.className = 'col-cards';
    col.appendChild(head);
    col.appendChild(cardsBox);
    board.appendChild(col);
    const list = state.board[key] || [];
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'col-empty';
      empty.textContent = key === 'all' ? '暂无会话' : '暂无该 agent 的会话';
      cardsBox.appendChild(empty);
      continue;
    }
    for (const s of list) cardsBox.appendChild(buildCard(s, key));
  }
}
// 点击列名 → 聚焦/取消聚焦该列（其他列缩小）
function toggleFocus(key) {
  state.focusedCol = state.focusedCol === key ? null : key;
  renderBoard();
}
// 隐藏一列（从配置里移除；全部列不可隐藏）
function hideCol(key) {
  if (key === 'all') { toast('「全部」列不可隐藏'); return; }
  const order = effectiveCols().filter((c) => c !== key);
  state.colOrder = order;
  saveColOrder(order);
  renderBoard();
  toast('已隐藏 ' + (agentMeta(key).name || key) + ' 列，点筛选栏「列设置」可恢复');
}
function buildCard(s, colKey) {
  const meta = agentMeta(s.agent);
  const def = state.agentsDef[s.agent] || {};
  // 状态唯一权威来源：liveRefs（SSE 实时维护），不用后端快照 s.status——
  // 后端 status 在请求瞬间计算，心跳窗口边缘可能算成 done，重建时会把进行中闪回已完成
  const live = state.liveRefs.has(s.id);
  const recent = !live && isRecentCompleted(s.id);
  const card = document.createElement('div');
  card.className = 's-card ' + (live ? 'active' : 'done') + (live ? ' flow-red' : '') + (recent ? ' flow-green' : '');
  card.dataset.live = live ? '1' : '0'; // 记录当前状态，供 SSE 差异化更新对比
  const isAll = colKey === 'all';
  const lastCmd = (s.last_user_text || '（暂无用户指令）').replace(/\s+/g, ' ').slice(0, 160);
  const titleHtml = `<span class="s-title" title="${esc(s.title)}">${esc(s.title || s.session_id.slice(0, 12))}</span>`;
  const agentTag = isAll
    ? `<span class="agent-tag" style="background:${meta.color}">${esc(meta.name)}</span>`
    : '';
  const statusHtml = live
    ? '<span class="s-status on"><span class="pulse"></span>进行中</span>'
    : '<span class="s-status">已完成</span>';
  // 跳转图标：优先用 AGENT_DEFS 里的 logo，否则 fallback 到字母
  const iconHtml = def.icon
    ? `<img src="/icons/${esc(def.icon)}" alt="" style="width:18px;height:18px;object-fit:contain">`
    : `<span style="font-size:12px;font-weight:700;color:${meta.color}">${esc((meta.name||'?').charAt(0))}</span>`;
  card.innerHTML = `
    <div class="s-row1">
      <span class="s-time">${fmtTimeLabel(s.last_seen)}</span>
      ${agentTag}
      ${titleHtml}
      ${statusHtml}
    </div>
    <div class="s-proj" title="${esc(s.project)}">${esc(shortProj(s.project) || '（无项目路径）')}</div>
    <div class="s-cmd" title="${esc(lastCmd)}">▸ ${esc(lastCmd)}</div>
    <div class="s-row2">
      <span class="s-msg">${s.msg_count} 条</span>
      ${recent ? '<button class="s-flow-dismiss" title="取消「刚完成」流光高亮，恢复普通已完成样式"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>已读</button>' : ''}
      <button class="s-more" data-ref="${esc(s.id)}" title="更多操作">···</button>
      <button class="s-jump" data-ref="${esc(s.id)}" data-agent="${esc(s.agent)}" title="跳转到 ${esc(meta.name||s.agent)}">
        ${iconHtml}
      </button>
    </div>`;
  card.addEventListener('click', (e) => {
    if (e.target.closest('.s-jump') || e.target.closest('.s-more') || e.target.closest('.s-flow-dismiss')) return;
    openSession(s.id);
  });
  card.querySelector('.s-jump').addEventListener('click', (e) => {
    e.stopPropagation();
    launchAgent(s.agent);
    // 点击跳转 = 视为已读：若该卡是「刚完成」绿色流光状态，同步取消高亮
    if (isRecentCompleted(s.id)) {
      dismissRecent(s.id);
      syncFlowDecor(s.id);
    }
  });
  card.querySelector('.s-more').addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(s, e.currentTarget);
  });
  card.querySelector('.s-flow-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissRecent(s.id);
    syncFlowDecor(s.id);
    toast('已恢复普通已完成样式');
  });
  return card;
}

/* ---------- 更多操作弹菜单 ---------- */
function openPopover(s, anchorEl) {
  closePopover();
  state.popoverFor = s.id;
  const meta = agentMeta(s.agent);
  const cmd = resumeCommand(s.agent, s.session_id);
  const hasResume = !!cmd;
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.innerHTML = `
    <div class="pop-head"><span class="dot" style="background:${meta.color}"></span>${esc(meta.name)} · 更多操作</div>
    <button class="pop-item" data-act="copy-cmd" ${hasResume ? '' : 'disabled'}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      <span>${hasResume ? '复制恢复命令' : '该 agent 无 CLI 恢复命令'}</span>
    </button>
    <button class="pop-item" data-act="open-term" ${hasResume && s.project ? '' : 'disabled'}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg>
      <span>${hasResume && s.project ? '打开终端并自动恢复' : (s.project ? '该 agent 无 CLI 恢复' : '缺少项目路径')}</span>
    </button>
    <button class="pop-item" data-act="copy-path" ${s.project ? '' : 'disabled'}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span>${s.project ? '复制项目路径' : '无项目路径'}</span>
    </button>
    <button class="pop-item" data-act="set-status">
      ${s.manual_done
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span>恢复自动判定（取消手动完成）</span>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg><span>标记为已完成（关闭心跳）</span>'}
    </button>
    <button class="pop-item" data-act="hide">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><path d="M3 3l18 18"/></svg>
      <span>隐藏此会话（不在看板显示）</span>
    </button>`;
  const r = anchorEl.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.right = (window.innerWidth - r.right) + 'px';
  pop.style.zIndex = 60;
  document.body.appendChild(pop);

  pop.addEventListener('click', async (e) => {
    const item = e.target.closest('.pop-item');
    if (!item || item.disabled) return;
    const act = item.dataset.act;
    if (act === 'copy-cmd') { await clip(cmd); toast('已复制：' + cmd); closePopover(); }
    else if (act === 'open-term') {
      try {
        const res = await fetch('/api/open-with', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: s.agent, sessionId: s.session_id, project: s.project }) });
        const d = await res.json();
        toast(d.ok ? '已开新终端并执行恢复命令' : '打开失败：' + d.error);
      } catch { toast('请求失败'); }
      closePopover();
    }
    else if (act === 'copy-path') { await clip(s.project); toast('已复制：' + s.project); closePopover(); }
    else if (act === 'set-status') {
      const target = s.manual_done ? 'auto' : 'done';
      try {
        const res = await fetch('/api/set-status', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: s.agent, sessionId: s.session_id, status: target }) });
        const d = await res.json();
        if (d.ok) {
          toast(target === 'done' ? '已标记为已完成，心跳已关闭' : '已恢复自动判定');
          closePopover();
          loadBoard();
          loadState();
        } else { toast('操作失败：' + (d.error || '')); closePopover(); }
      } catch { toast('请求失败'); closePopover(); }
    }
    else if (act === 'hide') {
      try {
        await fetch('/api/hide', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: s.agent, sessionId: s.session_id }) });
        state.board = removeFromBoard(state.board, s.agent, s.session_id);
        renderBoard();
        renderChips();
        toast('已隐藏，可在顶栏「隐藏」图标恢复');
      } catch { toast('操作失败'); }
      closePopover();
    }
  });
}
function closePopover() {
  document.querySelectorAll('.popover').forEach((n) => n.remove());
  state.popoverFor = null;
}
document.addEventListener('click', (e) => {
  if (state.popoverFor && !e.target.closest('.popover') && !e.target.closest('.s-more') && !e.target.closest('#btn-hidden') && !e.target.closest('#btn-cols') && !e.target.closest('#btn-agents')) closePopover();
});

/* ---------- 详情抽屉 ---------- */
// 抽屉增强：回合分组、过滤、排序、搜索、锚点导航、复制、跳转
let drawerState = { rounds: [], mode: 'all', order: 'desc', term: '', anchorsVisible: true };
async function openSession(ref) {
  if (!ref) { toast('无效的会话引用'); return; }
  try {
    const r = await fetch('/api/session/' + encodeURIComponent(ref));
    if (!r.ok) { toast('会话不存在或已删除（HTTP ' + r.status + '）'); return; }
    const s = await r.json();
    if (!s || s.error || !s.messages) { toast(s.error || '会话数据无效'); return; }
    const meta = agentMeta(s.agent);
    // Header：保留
    $('drawer-head').innerHTML = `
      <div class="row">
        <span class="agent-tag" style="background:${meta.color}">${esc(meta.name)}</span>
        <span style="font-size:12px;color:var(--text2)">${s.msg_count} 条消息 · ${roundCount(s.messages)} 回合</span>
        <span style="font-size:12px;color:var(--text3);margin-left:auto">${esc(s.first_seen ? fmtDayFull(s.first_seen).slice(0,16) : '')}</span>
        <button class="icon-btn" id="d-close" style="width:32px;height:32px" title="关闭">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <h2>${esc(s.title || s.session_id || '未命名会话')}</h2>
      <div style="font-size:12px;color:var(--text3);word-break:break-all">
        ${esc(s.project || '')} · ${esc(meta.name)} · ${esc(s.session_id.slice(0,12))}
      </div>`;
    // Body：工具栏 + 主区（锚点 + 回合流）
    const body = $('drawer-body'); body.innerHTML = '';
    body.classList.add('d-body-rich');
    const toolbar = document.createElement('div');
    toolbar.className = 'd-toolbar';
    toolbar.innerHTML = `
      <div class="d-tabs">
        <button class="d-tab on" data-f="all">全部 <span class="d-cnt" data-cnt="all">0</span></button>
        <button class="d-tab" data-f="user">我的指令 <span class="d-cnt" data-cnt="user">0</span></button>
        <button class="d-tab" data-f="assistant">AI 回复 <span class="d-cnt" data-cnt="assistant">0</span></button>
      </div>
      <div class="d-spacer"></div>
      <input class="d-search" placeholder="搜索消息…">
      <button class="d-icon-btn d-sort" title="切换顺序">↓ 倒序</button>
      <button class="d-icon-btn d-copy" title="复制全部为 Markdown">⧉ 复制</button>
      <button class="d-icon-btn d-jump" title="跳转到该应用窗口">→ 跳转</button>
    `;
    body.appendChild(toolbar);
    const main = document.createElement('div');
    main.className = 'd-main';
    body.appendChild(main);
    // 过滤无效消息、构造回合
    const filtered = s.messages.filter((m) => m.kind !== 'heartbeat' && m.kind !== 'title' && m.text);
    const rounds = buildRounds(filtered);
    drawerState = { rounds, mode: 'all', order: 'desc', term: '', sessionMeta: { ...s, agentMeta: meta } };
    main.innerHTML = `
      <aside class="d-anchors"><div class="d-anchors-head">我的指令</div><div class="d-anchors-list"></div></aside>
      <div class="d-flow"></div>
    `;
    // 渲染 + 绑定事件
    drawCounts();
    renderDrawer();
    bindDrawerEvents(s);
    $('drawer').classList.add('open');
    $('mask').classList.add('open');
    $('d-close').onclick = closeDrawer;
  } catch (e) { console.error('[openSession] failed:', ref, e); toast('会话加载失败：' + (e.message || e)); }
}
function roundCount(msgs) {
  let n = 0;
  for (const m of msgs) if (m.role === 'user' && !m.kind?.match(/heartbeat|title/)) n++;
  return n;
}
// 把消息流切成回合：以 user 消息开头，到下一条 user 消息为止
function buildRounds(msgs) {
  const rounds = [];
  let cur = null;
  for (const m of msgs) {
    const isUser = m.role === 'user';
    if (isUser) {
      if (cur) rounds.push(cur);
      cur = { user: m, replies: [] };
    } else {
      if (!cur) cur = { user: null, replies: [] };
      cur.replies.push(m);
    }
  }
  if (cur) rounds.push(cur);
  return rounds;
}
function drawCounts() {
  const all = drawerState.rounds.length;
  let user = 0, ai = 0;
  for (const r of drawerState.rounds) {
    if (r.user) user++;
    ai += r.replies.filter((m) => m.role !== 'summary').length;
  }
  $('drawer-body')?.querySelector('[data-cnt="all"]') && (document.querySelector('.d-tab[data-f="all"] .d-cnt').textContent = all);
  document.querySelector('.d-tab[data-f="user"] .d-cnt').textContent = user;
  document.querySelector('.d-tab[data-f="assistant"] .d-cnt').textContent = ai;
}
function renderDrawer() {
  const s = drawerState;
  const flow = document.querySelector('.d-flow');
  const anchors = document.querySelector('.d-anchors-list');
  if (!flow || !anchors) return;
  flow.innerHTML = ''; anchors.innerHTML = '';
  let rounds = s.rounds.slice();
  if (s.order === 'desc') rounds.reverse();
  const term = s.term.toLowerCase();
  // 过滤模式：user 只显示 user msg；assistant 只显示 replies；all 都显示
  let visible = 0;
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    if (!r.user) continue;
    const matchTerm = !term || (r.user.text || '').toLowerCase().includes(term) || r.replies.some((m) => (m.text || '').toLowerCase().includes(term));
    if (term && !matchTerm) continue;
    visible++;
    // 锚点
    const a = document.createElement('div');
    a.className = 'd-anchor';
    a.dataset.idx = String(i);
    const label = smartTitle(r.user.text || '').slice(0, 22) || (r.user.text || '').slice(0, 22) || '指令';
    a.innerHTML = `<span class="d-anchor-time">${fmtClock(r.user.ts)}</span><span class="d-anchor-text">${esc(label)}</span>`;
    a.onclick = () => {
      const el = flow.querySelector(`[data-round="${i}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.querySelectorAll('.d-anchor.on').forEach((x) => x.classList.remove('on'));
      a.classList.add('on');
    };
    anchors.appendChild(a);
    // 回合
    const round = document.createElement('div');
    round.className = 'd-round';
    round.dataset.round = String(i);
    const showUser = s.mode !== 'assistant';
    const showReplies = s.mode !== 'user';
    round.innerHTML = `
      <div class="d-round-head" data-toggle>
        <span class="d-role-tag user">你</span>
        <span class="d-time">${fmtClock(r.user.ts)} · ${esc((r.user.text || '').slice(0, 70))}</span>
        <span class="d-round-cnt">${r.replies.length} 条回复</span>
        <span class="d-round-toggle">▾</span>
      </div>
      ${showUser ? `<div class="d-msg user${term && (r.user.text||'').toLowerCase().includes(term) ? ' match' : ''}"><div class="d-meta"><b>你</b><span>${fmtDayFull(r.user.ts)}</span></div><div class="d-text">${esc(r.user.text || '')}</div></div>` : ''}
      ${showReplies ? '<div class="d-round-replies">' + r.replies.map((m) => {
        const cls = m.role === 'summary' ? 'summary' : 'assistant';
        const isMatch = term && (m.text || '').toLowerCase().includes(term);
        return `<div class="d-msg ${cls}${isMatch ? ' match' : ''}"><div class="d-meta"><b>${m.role === 'summary' ? '会话总结' : 'AI'}</b><span>${fmtDayFull(m.ts)}</span><button class="d-msg-copy" data-copy="${esc(m.text || '')}">⧉</button></div><div class="d-text">${esc(m.text || '')}</div></div>`;
      }).join('') + '</div>' : ''}
    `;
    // 点击 head 折叠/展开
    round.querySelector('.d-round-head').onclick = () => round.classList.toggle('collapsed');
    flow.appendChild(round);
  }
  if (!visible) {
    flow.innerHTML = '<div class="d-empty">没有匹配的消息</div>';
    anchors.innerHTML = '<div class="d-anchor-empty">无</div>';
  }
  // 单条消息复制
  flow.querySelectorAll('.d-msg-copy').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const t = b.dataset.copy;
      await navigator.clipboard.writeText(t);
      toast('已复制单条消息');
    };
  });
  // 滚动监听：自动高亮当前可见锚点
  if (s._scrollHandler) flow.removeEventListener('scroll', s._scrollHandler);
  s._scrollHandler = () => {
    const rect = flow.getBoundingClientRect();
    let cur = -1;
    flow.querySelectorAll('.d-round').forEach((el) => {
      if (el.getBoundingClientRect().top - rect.top < 60) cur = Number(el.dataset.round);
    });
    if (cur >= 0) {
      document.querySelectorAll('.d-anchor.on').forEach((x) => x.classList.remove('on'));
      const a = anchors.querySelector(`.d-anchor[data-idx="${cur}"]`);
      if (a) a.classList.add('on');
    }
  };
  flow.addEventListener('scroll', s._scrollHandler);
}
function bindDrawerEvents(s) {
  const body = $('drawer-body');
  // Tab 过滤
  body.querySelectorAll('.d-tab').forEach((tab) => {
    tab.onclick = () => {
      body.querySelectorAll('.d-tab').forEach((t) => t.classList.remove('on'));
      tab.classList.add('on');
      drawerState.mode = tab.dataset.f;
      renderDrawer();
    };
  });
  // 排序
  body.querySelector('.d-sort').onclick = () => {
    drawerState.order = drawerState.order === 'desc' ? 'asc' : 'desc';
    const btn = body.querySelector('.d-sort');
    btn.textContent = drawerState.order === 'desc' ? '↓ 倒序' : '↑ 正序';
    renderDrawer();
  };
  // 搜索
  const search = body.querySelector('.d-search');
  let st;
  search.addEventListener('input', () => {
    clearTimeout(st);
    st = setTimeout(() => { drawerState.term = search.value.trim(); renderDrawer(); }, 250);
  });
  // 复制全部
  body.querySelector('.d-copy').onclick = async () => {
    const md = buildMarkdown(s);
    await navigator.clipboard.writeText(md);
    toast('已复制 Markdown 到剪贴板');
  };
  // 跳转
  body.querySelector('.d-jump').onclick = () => launchAgent(s.agent);
}
function buildMarkdown(s) {
  const lines = [`# ${s.title || s.session_id}`, '', `- Agent: ${s.agent}`, `- Project: ${s.project || '(无)'}`, `- Messages: ${s.msg_count}`, ''];
  for (const r of drawerState.rounds) {
    if (r.user) lines.push(`## ${fmtDayFull(r.user.ts)} — 你`, '', r.user.text || '', '');
    for (const m of r.replies) {
      lines.push(`### ${fmtDayFull(m.ts)} — ${m.role === 'summary' ? '总结' : 'AI'}`, '', m.text || '', '');
    }
  }
  return lines.join('\n');
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('mask').classList.remove('open');
}

/* ---------- 导入 ---------- */
function toggleImport() {
  const box = $('import-box');
  box.style.display = box.style.display === 'none' ? 'flex' : 'none';
}
$('btn-import').onclick = toggleImport;
$('imp-cancel').onclick = toggleImport;
$('imp-submit').onclick = async () => {
  const raw = $('imp-json').value.trim();
  if (!raw) { toast('请粘贴对话 JSON'); return; }
  let messages;
  try {
    messages = JSON.parse(raw);
    if (!Array.isArray(messages)) throw new Error('必须是数组');
  } catch { toast('JSON 格式错误，请检查'); return; }
  try {
    const r = await fetch('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: $('imp-agent').value.trim() || 'other',
        title: $('imp-title').value.trim(),
        project: $('imp-project').value.trim(),
        messages,
      }),
    });
    const d = await r.json();
    toast(`已导入 ${d.imported} 条消息`);
    if (d.imported > 0) { toggleImport(); $('imp-json').value = ''; loadState(); loadBoard(); }
  } catch { toast('导入失败'); }
};

/* ---------- 过滤交互 ---------- */
let qTimer = null;
$('f-q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.q = e.target.value.trim(); loadBoard(); }, 400);
});
$('f-project').addEventListener('change', (e) => { state.project = e.target.value; loadBoard(); });
$('f-onlyuser').addEventListener('change', (e) => {
  state.onlyUser = e.target.value === '1';
  loadBoard();       // 看板按过滤重载
  renderActive();    // 顶部活跃区同步过滤（数据已在 state.active 中）
});
$('f-range').addEventListener('change', (e) => { state.range = Number(e.target.value); loadBoard(); });
$('active-project').addEventListener('change', (e) => { state.activeProject = e.target.value; renderActive(); });
$('active-range').addEventListener('change', (e) => {
  state.activeRange = e.target.value;
  loadState();
});
$('btn-rescan').onclick = async () => {
  toast('开始重新扫描数据源，完成后自动刷新…');
  try {
    const r = await fetch('/api/rescan', { method: 'POST' });
    const d = await r.json();
    if (r.status === 409) { toast(d.error || '当前正在扫描，请稍后再试'); return; }
    // 后端已异步后台扫描：响应立即返回，board 由 SSE 'scan' finished 事件自动刷新
    toast('扫描已在后台进行…');
  } catch { toast('扫描请求失败'); }
};
$('mask').onclick = closeDrawer;

/* ---------- 已隐藏会话管理 ---------- */
async function openHiddenManager() {
  closePopover();
  state.popoverFor = 'hidden';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.minWidth = '290px';
  pop.style.maxHeight = '70vh';
  pop.style.overflowY = 'auto';
  document.body.appendChild(pop);
  try {
    const r = await fetch('/api/hidden'); const d = await r.json();
    let html = `<div class="pop-head">已隐藏的会话 <span style="opacity:.5;font-weight:400">（点恢复即重新显示）</span></div>`;
    if (!d.items.length) html += `<div style="padding:12px 14px;color:var(--text3);font-size:13px">暂无隐藏的会话</div>`;
    for (const h of d.items) {
      const color = (state.agentsDef[h.agent] || {}).color || '#888780';
      const name = (state.agentsDef[h.agent] || {}).name || h.agent;
      html += `<div class="pop-item hidden-item" data-agent="${esc(h.agent)}" data-sid="${esc(h.session_id)}" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <span class="hi-info" style="display:flex;align-items:center;gap:8px;min-width:0"><span class="dot" style="background:${color}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)} · ${esc(h.session_id.slice(0, 10))}…</span></span>
        <button class="hi-restore" data-agent="${esc(h.agent)}" data-sid="${esc(h.session_id)}" style="flex:none;padding:3px 10px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);cursor:pointer">恢复</button>
      </div>`;
    }
    pop.innerHTML = html;
    pop.querySelectorAll('.hi-restore').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const agent = b.dataset.agent, sid = b.dataset.sid;
      try {
        await fetch('/api/unhide', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent, sessionId: sid }) });
        const item = b.closest('.hidden-item'); if (item) item.remove();
        toast('已恢复，看板将重新显示该会话');
        loadBoard();
      } catch { toast('恢复失败'); }
    }));
  } catch { pop.innerHTML = '<div style="padding:12px;color:var(--text3)">加载失败</div>'; }
}
$('btn-hidden').onclick = openHiddenManager;

/* ---------- 瀑布流列管理 ---------- */
function openColManager() {
  closePopover();
  state.popoverFor = 'cols';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.minWidth = '300px';
  document.body.appendChild(pop);
  const current = effectiveCols();
  const items = [...state.agentIds];
  let html = `<div class="pop-head">瀑布流列设置 <span style="opacity:.5;font-weight:400">（勾选显示，上下拖动顺序）</span></div>
    <div style="padding:6px 8px;max-height:56vh;overflow-y:auto">`;
  for (const id of items) {
    const meta = id === 'all' ? { name: '全部', color: '#888780' } : agentMeta(id);
    const on = current.includes(id);
    html += `<div class="col-mgr-row" data-id="${esc(id)}" style="display:flex;align-items:center;gap:8px;padding:7px 6px;border-radius:7px;cursor:move">
      <input type="checkbox" class="col-mgr-cb" ${on ? 'checked' : ''} style="width:15px;height:15px;accent-color:${meta.color}">
      <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${meta.color}"></span>
      <span style="flex:1;font-size:13px">${esc(meta.name)}</span>
      <span style="font-size:11px;color:var(--text3)">${(state.board[id]||[]).length} 条</span>
      <span style="cursor:grab;opacity:.5">⠿</span>
    </div>`;
  }
  html += `</div>
    <div style="display:flex;gap:8px;padding:8px 10px;border-top:1px solid var(--border)">
      <button class="btn" style="flex:1;min-height:36px;padding:6px 10px;font-size:13px" id="cols-done">完成</button>
      <button class="btn" style="min-height:36px;padding:6px 10px;font-size:13px" id="cols-reset">恢复默认</button>
    </div>`;
  pop.innerHTML = html;

  // 勾选 → 更新显示
  const applyCols = () => {
    const order = [];
    const cbs = pop.querySelectorAll('.col-mgr-row');
    for (const row of cbs) {
      const id = row.dataset.id;
      const cb = row.querySelector('.col-mgr-cb');
      if (cb.checked) order.push(id);
    }
    state.colOrder = order;
    saveColOrder(order);
    renderBoard();
  };
  pop.querySelectorAll('.col-mgr-cb').forEach((cb) => cb.addEventListener('change', applyCols));

  // 简单拖拽排序（HTML5 drag 接口）
  let dragEl = null;
  pop.querySelectorAll('.col-mgr-row').forEach((row) => {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragEl = row;
      row.style.opacity = '.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { row.style.opacity = ''; dragEl = null; });
    row.addEventListener('dragover', (e) => { e.preventDefault(); });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragEl || dragEl === row) return;
      const box = pop.querySelector('.col-mgr-row').parentElement;
      const rows = [...box.querySelectorAll('.col-mgr-row')];
      const from = rows.indexOf(dragEl), to = rows.indexOf(row);
      if (from < 0 || to < 0) return;
      box.insertBefore(dragEl, to > from ? row.nextSibling : row);
      applyCols();
    });
  });

  pop.querySelector('#cols-done').onclick = () => { applyCols(); closePopover(); toast('列设置已保存'); };
  pop.querySelector('#cols-reset').onclick = () => {
    // 恢复默认＝恢复到「探测为已安装或有历史数据」过滤后的默认列，不是恢复成全部 agent
    state.colOrder = null;
    saveColOrder(['all', ...state.defaultAgentIds]);
    closePopover();
    loadBoard();
  };
}
$('btn-cols').onclick = openColManager;

/* ---------- 应用管理（探测各 AI Agent 安装状态，只读） ---------- */
// 安装兜底计时器：SSE 断线重连可能丢掉终态事件，导致安装按钮永久锁死。
// 全局只会有一个安装任务在跑（服务端也是这个限制），单个句柄够用。
let installFallbackTimer = null;

async function openAgentManager() {
  closePopover();
  state.popoverFor = 'agents';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.minWidth = '420px';
  pop.style.maxWidth = '520px';
  document.body.appendChild(pop);
  pop.innerHTML = '<div class="pop-head">应用管理</div><div style="padding:16px;color:var(--text3);font-size:13px">检测中…</div>';

  let data;
  try {
    const r = await fetch('/api/agents/status');
    data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
  } catch {
    pop.innerHTML = '<div class="pop-head">应用管理</div><div style="padding:16px;color:var(--text3);font-size:13px">检测失败，请稍后重试</div>';
    return;
  }

  const agents = Object.values(data.agents || {});
  let html = `<div class="pop-head">应用管理 <span style="opacity:.5;font-weight:400">（命令行/桌面类工具支持一键安装）</span></div>
    <div style="padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:60vh;overflow-y:auto">`;
  for (const a of agents) {
    const badge = a.installed
      ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#DCFCE7;color:#15803D">已安装${a.version ? ' ' + esc(a.version) : ''}</span>`
      : `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--border);color:var(--text3)">未检测到</span>`;
    // 未安装的 cli/gui 类工具、且有至少一种安装方式，才给按钮；
    // 按钮文案区分「能静默装」（picked 有值）和「只能手动下载」（picked 为空）
    const canInstall = !a.installed && (a.tier === 'cli' || a.tier === 'gui') && a.install && (a.install.methods || []).length;
    const btnLabel = a.install && a.install.picked ? '安装' : '下载安装';
    const btn = canInstall
      ? `<div style="margin-top:6px"><button class="btn ab-install" data-id="${esc(a.id)}" style="min-height:28px;padding:3px 12px;font-size:12px">${btnLabel}</button></div>`
      : '';
    html += `<div class="ab-card" data-id="${esc(a.id)}" style="border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center">
      <div style="width:32px;height:32px;border-radius:8px;margin:0 auto 6px;background:${esc(a.color || '#888')};display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:600">${esc((a.name || a.id || '?').slice(0, 1))}</div>
      <div style="font-size:12px;font-weight:600;margin-bottom:4px">${esc(a.name || a.id)}</div>
      ${badge}
      <div class="ab-progress" style="font-size:11px;color:var(--text3);margin-top:6px;min-height:14px"></div>
      ${btn}
    </div>`;
  }
  html += '</div>';
  pop.innerHTML = html;

  // 安装按钮：能静默装的（picked 有值）走「确认 + POST + SSE」；只能手动下载的直接跳转下载页
  pop.querySelectorAll('.ab-install').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.id;
      const a = data.agents[id];

      // 没有能静默执行的方法：找 download 方式直接跳转，不经过后端、不占用安装锁。
      // 注意：这个 if 块不是每条路径都 return——找不到可跳转的 download 方式时会故意穿透到
      // 下面，落回原来的静默安装流程（见块尾注释）。
      if (!a.install.picked) {
        const dl = (a.install.methods || []).find((m) => m.kind === 'download');
        // dl.url 目前只会来自仓库里 adapter 文件写死的配置，不是运行时用户输入；
        // 但既然是要传给 window.open 做页面导航（不是 spawnSync 那种 shell 命令上下文），
        // 顺手校验一下协议，避免以后有人不小心把 javascript:/data: 之类的值写进这个字段。
        if (dl && dl.url && /^https?:\/\//i.test(dl.url)) {
          window.open(dl.url, '_blank');
          toast('已在新标签页打开下载页，按提示完成安装后关闭再重新打开本弹窗可刷新状态');
          return;
        }
        // 穿透到这里：没有 download 方式，或 url 协议不是 http(s)（理论上不会发生，
        // canInstall 已经要求 methods.length>0，且 adapter 数据都是硬编码的 https 字面量）。
        // 不在前端假装成功，落回原来的静默安装流程，让后端 installAgent 报 no-method，
        // SSE 会显示「这个平台没有可用的安装方式」
      }

      // pickedCommand 是服务端用 methodToCommand() 拼出的真实命令（和 installAgent 实际执行的完全一致），
      // 前端不再自己拼一遍，避免两边逻辑分叉（比如漏掉 winget 的 flags）
      const cmdHint = a.install.pickedCommand || '(未知)';
      const warn = a.install.warning ? `\n\n注意：${a.install.warning}` : '';
      if (!confirm(`即将安装 ${a.name || id}\n\n将执行：${cmdHint}${warn}\n\n确定继续吗？`)) return;
      b.disabled = true;
      // 一次只能装一个：把所有安装按钮都禁掉，等这次跑完再刷新
      pop.querySelectorAll('.ab-install').forEach((x) => { x.disabled = true; });
      try {
        const r = await fetch(`/api/agents/${encodeURIComponent(id)}/install`, { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
        // 兜底：SSE 如果断线重连，装完的终态事件可能丢失，按钮会一直锁死。
        // 给一个比后端 10 分钟安装超时更长的兜底计时器，到点了还没收到终态事件就自己解锁。
        if (installFallbackTimer) clearTimeout(installFallbackTimer);
        installFallbackTimer = setTimeout(() => {
          installFallbackTimer = null;
          document.querySelectorAll('.ab-install').forEach((x) => { x.disabled = false; });
          toast('安装状态未知，可能已完成或失败——请刷新查看');
        }, 11 * 60 * 1000);
      } catch (e) {
        toast('安装请求失败：' + (e.message || '未知错误'));
        pop.querySelectorAll('.ab-install').forEach((x) => { x.disabled = false; });
      }
    };
  });
}
$('btn-agents').onclick = openAgentManager;

/* ---------- SSE ---------- */
function connectSSE() {
  const es = new EventSource('/api/events');
  // 新消息：刷新统计；看板防抖刷新（避免高频 message 触发全量重建造成状态闪烁/视觉跳动，
  // 重建时 buildCard 用 liveRefs 判定状态，不会闪回「已完成」）
  let boardTimer = null;
  const refreshBoard = () => {
    if (boardTimer) return;
    boardTimer = setTimeout(() => { boardTimer = null; loadBoard(); }, 600);
  };
  es.addEventListener('message', () => { loadState(); refreshBoard(); });
  es.addEventListener('active', (ev) => {
    try {
      const arr = JSON.parse(ev.data);
      // 兼容两种条目结构：getActive() 返回 {sessionRef}；心跳曾返回 {sessionId}
      // 且只认 active 明确为 true 的条目（防御：任何来源都不该把 inactive 会话当活跃）
      const liveSet = new Set(
        arr
          .filter((a) => a.active !== false)
          .map((a) => a.sessionRef || (a.agent && a.sessionId ? a.agent + ':' + a.sessionId : null))
          .filter(Boolean)
      );
      state.liveRefs = liveSet; // 权威状态
      // 进行中 → 已完成 迁移检测：用上一份快照对比本次快照（覆盖 liveRefs 之前取旧值），
      // 离开活跃窗口的会话标记为「刚完成」（绿色流光）。首次快照只建立基线，不误标。
      if (state._activeInit) {
        for (const ref of state._prevRefs) {
          if (!liveSet.has(ref)) markRecentlyCompleted(ref);
        }
      }
      state._activeInit = true;
      state._prevRefs = liveSet;
      // 逐卡差异化更新：新状态与卡上记录的当前状态（data-live）对比——
      // 一样的完全跳过（不触碰 DOM），只有变化的卡才单独切换。
      // 避免对全部 session 卡做无意义的 class/标签重写造成视觉闪烁。
      document.querySelectorAll('#board .s-card').forEach((el) => {
        const ref = el.querySelector('.s-more')?.dataset.ref;
        if (!ref) return;
        const nowLive = liveSet.has(ref);
        const prevLive = el.dataset.live === '1';
        if (nowLive !== prevLive) {
          // 状态变化：单独更新这一张卡
          el.dataset.live = nowLive ? '1' : '0';
          el.classList.toggle('active', nowLive);
          el.classList.toggle('done', !nowLive);
          const lbl = el.querySelector('.s-status');
          if (lbl) {
            lbl.outerHTML = nowLive
              ? '<span class="s-status on"><span class="pulse"></span>进行中</span>'
              : '<span class="s-status">已完成</span>';
          }
        }
        // 流光装饰与状态解耦刷新：新完成迁移后立即点亮绿色流光（含「已读」按钮）
        applyFlowDecor(el, ref, nowLive);
      });
    } catch {}
  });
  // 安装进度：更新对应卡片的状态行。弹窗关掉了就什么也不做（querySelector 找不到元素）
  es.addEventListener('agent-install-progress', (ev) => {
    try {
      const d = JSON.parse(ev.data);
      const card = document.querySelector(`.ab-card[data-id="${CSS.escape(d.agentId)}"]`);
      const line = card && card.querySelector('.ab-progress');
      const TEXT = {
        blocked: () => '⛔ ' + (d.message || '当前网络环境无法安装'),
        'deps-missing': () => `⛔ 需要 Node ${d.need}，当前 ${d.have}`,
        'no-method': () => '⛔ 这个平台没有可用的安装方式',
        installing: () => '⏳ 安装中…',
        verifying: () => '⏳ 校验中…',
        done: () => '✅ 完成 ' + (d.version || ''),
        failed: () => '❌ ' + (d.reason || d.stderr || '安装失败'),
      };
      if (line) line.textContent = (TEXT[d.step] || (() => d.step))();
      // 终态：解锁按钮 + 刷新弹窗（done 时要展示 tellUser 提示）
      if (d.step === 'done' || d.step === 'failed' || d.step === 'blocked'
          || d.step === 'deps-missing' || d.step === 'no-method') {
        if (installFallbackTimer) { clearTimeout(installFallbackTimer); installFallbackTimer = null; }
        document.querySelectorAll('.ab-install').forEach((x) => { x.disabled = false; });
        if (d.step === 'done') {
          const tips = (d.tellUser || []).join('\n');
          toast('安装完成' + (d.version ? '：' + d.version : ''));
          if (tips) setTimeout(() => alert('安装完成，几点说明：\n\n' + tips), 300);
          // 重新探测，刷新卡片状态
          if (state.popoverFor === 'agents') setTimeout(() => openAgentManager(), 600);
        }
      }
    } catch {}
  });
  es.addEventListener('scan', (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (d.finished) { toast('数据扫描完成'); loadState(); loadBoard(); }
    } catch {}
  });
  es.addEventListener('hide', (ev) => {
    try {
      const d = JSON.parse(ev.data);
      const set = new Set(d.sessions.map((x) => x.agent + ':' + x.sessionId));
      for (const k of Object.keys(state.board)) {
        state.board[k] = state.board[k].filter((s) => !set.has(s.agent + ':' + s.session_id));
      }
      renderBoard();
    } catch {}
  });
  es.addEventListener('unhide', () => { loadBoard(); });
  es.onerror = () => { /* 断线自动重连 */ };
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------- 启动 ---------- */
(async () => {
  loadRecentDone();
  await loadState();
  await loadBoard();
  connectSSE();
})();
