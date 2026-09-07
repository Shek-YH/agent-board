'use strict';
/* Agent Board 资料库面板：提示词库（分组+提示词）+ 知识索引（分类+条目）。
 * 依赖后端 /api/prompt-* 与 /api/index-* 两组 REST 接口。
 * UMD：浏览器挂 window.AgentBoardLibraryUi，Node 下可 require 做纯逻辑测试。 */

(function exposeLibraryUi(root) {
  function icon(name) {
    const paths = {
      close: '<path d="M18 6 6 18M6 6l12 12"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      edit: '<path d="m4 16-.8 4.8L8 20l10.7-10.7a2.1 2.1 0 0 0-3-3L4 16Z"/><path d="m14.5 7.5 2 2"/>',
      trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
      copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
      use: '<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
      up: '<path d="m18 15-6-6-6 6"/>',
      down: '<path d="m6 9 6 6 6-6"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
      layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
      send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"/>',
    };
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
  }

  /* ---------- 纯逻辑（node 可测） ---------- */

  // 服务端同款长度上限（与 lib/prompt-service.js、lib/index-service.js 保持一致）
  const LIMITS = {
    groupName: 50, promptTitle: 100, promptContent: 10000, maxGroups: 50, maxPromptsPerGroup: 200,
    category: 50, entryTitle: 200, entryContent: 100000, maxEntries: 2000,
  };

  function text(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  function checkLength(value, field, max) {
    const s = String(value == null ? '' : value).trim();
    if (!s) throw new Error(`${field}不能为空`);
    if (s.length > max) throw new Error(`${field}长度不能超过 ${max} 个字符`);
    return s;
  }

  // 文本截断（提示词卡片预览用）：超 max 在词边界截断并加省略号；不会切坏 markdown 标记。
  function clampText(value, max) {
    const s = String(value == null ? '' : value);
    if (!max || s.length <= max) return s;
    const slice = s.slice(0, max);
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > max * 0.6) return slice.slice(0, lastSpace) + '…';
    return slice + '…';
  }

  function sortNumericAsc(items, key) {
    return items.slice().sort((a, b) => (Number(a[key]) || 0) - (Number(b[key]) || 0) || String(a.created_at || a.createdAt || '').localeCompare(String(b.created_at || b.createdAt || '')));
  }

  function filterText(items, term, fields) {
    const q = String(term || '').trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => fields.some((f) => String(item[f] == null ? '' : item[f]).toLowerCase().includes(q)));
  }

  /* ---------- DOM 工具（仅浏览器路径使用） ---------- */

  function dom() {
    if (typeof document === 'undefined') return null;
    return {
      el(tag, attrs = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) {
          if (value == null) continue;
          if (key === 'class') node.className = value;
          else if (key === 'dataset') Object.assign(node.dataset, value);
          else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
          else node.setAttribute(key, String(value));
        }
        for (const child of children.flat()) {
          if (child == null) continue;
          node.append(child.nodeType ? child : document.createTextNode(String(child)));
        }
        return node;
      },
    };
  }

  function createLibraryPanels({ requestJson, escapeHtml, notify, fetchImpl } = {}) {
    const esc = escapeHtml || ((s) => String(s == null ? '' : s));
    const toast = notify || (() => {});
    const http = requestJson;
    if (typeof http !== 'function') throw new TypeError('library-ui requires requestJson()');

    // 闭包状态（每次 show 重新拉取，确保多窗口一致）
    const state = {
      mode: null,
      groups: [], prompts: [], categories: [], entries: [],
      groupId: null, category: '', term: '',
      collapsed: new Set(), // 折叠的分类名（索引分组视图）
      indexView: 'list',    // 索引内部视图：list | detail
      detailId: null,       // 详情视图当前条目 id
      expanded: new Set(), // entry id 展开状态
      hostEl: null, // 渲染宿主（Todo 抽屉内的 .todo-lib-host，或主区面板容器）
    };

    // 一次性把 icon() 调用结果打包成字典，避免模板里写成 icons.xxx 时只拿到函数引用
    const icons = {
      close: icon('close'), plus: icon('plus'), edit: icon('edit'), trash: icon('trash'),
      copy: icon('copy'), use: icon('use'), up: icon('up'), down: icon('down'),
      search: icon('search'), folder: icon('folder'), layers: icon('layers'), send: icon('send'),
    };

    /* ---------- 后端调用封装 ---------- */
    function readError(error) {
      return error?.message || String(error || '操作失败');
    }
    async function listPrompts() {
      const [g, p] = await Promise.all([http('/api/prompt-groups'), http('/api/prompts')]);
      state.groups = Array.isArray(g.items) ? g.items : [];
      state.prompts = Array.isArray(p.items) ? p.items : [];
      if (!state.groups.some((x) => x.id === state.groupId)) state.groupId = state.groups[0]?.id || null;
      return { groups: state.groups, prompts: state.prompts };
    }
    async function listIndex() {
      const data = await http('/api/index-entries');
      state.entries = Array.isArray(data.items) ? data.items : [];
      state.categories = Array.isArray(data.categoryOrder) ? data.categoryOrder : [];
      if (!state.categories.includes(state.category)) state.category = '';
      return { entries: state.entries, categories: state.categories };
    }
    async function refresh(mode) {
      const m = mode || state.mode;
      if (m === 'prompts') { await listPrompts(); return renderPrompts(); }
      if (m === 'index') { await listIndex(); return renderIndex(); }
      return null;
    }

    /* ---------- 渲染：提示词库（分组 chips + 单栏卡片；分组管理进弹窗） ---------- */
    function renderPrompts() {
      const panel = state.hostEl;
      if (!panel) return;
      const groups = sortNumericAsc(state.groups, 'sort_order');
      const selectedId = state.groups.some((x) => x.id === state.groupId) ? state.groupId : groups[0]?.id || null;
      state.groupId = selectedId;
      const selected = groups.find((x) => x.id === selectedId) || null;
      const sorted = sortNumericAsc(state.prompts.filter((p) => p.group_id === selectedId), 'sort_order');
      const term = state.term;
      const shown = filterText(sorted, term, ['title', 'content']);
      const chips = groups.map((g) => {
        const n = state.prompts.filter((p) => p.group_id === g.id).length;
        const on = g.id === selectedId;
        return `<button type="button" class="lib-chip${on ? ' on' : ''}" data-act="pg-select" data-id="${esc(g.id)}">${esc(g.name)}<span class="lib-group-cnt">${n}</span></button>`;
      }).join('');
      const cards = shown.length
        ? shown.map((p) => {
          const meta = p.use_count ? `<span class="lib-badge" title="最近使用：${esc(p.last_used_at || '')}">使用 ${Number(p.use_count) || 0} 次</span>` : '';
          return `<article class="lib-card" data-id="${esc(p.id)}">
            <div class="lib-card-head">
              <div class="lib-card-title" title="${esc(p.title)}">${esc(p.title) || '<span class="lib-muted">（无标题）</span>'}</div>
              <span class="lib-card-ops">
                ${meta}
                <button type="button" class="lib-mini" data-act="prompt-copy" data-id="${esc(p.id)}" title="复制提示词内容">${icons.copy}</button>
                <button type="button" class="lib-mini" data-act="prompt-use" data-id="${esc(p.id)}" title="标记一次使用">${icons.use}</button>
                <button type="button" class="lib-mini" data-act="prompt-edit" data-id="${esc(p.id)}" title="编辑">${icons.edit}</button>
                <button type="button" class="lib-mini lib-danger" data-act="prompt-del" data-id="${esc(p.id)}" title="删除">${icons.trash}</button>
              </span>
            </div>
            <div class="lib-card-body">${p.content ? esc(clampText(p.content, 260)) : '<span class="lib-muted">（无内容）</span>'}</div>
          </article>`;
        }).join('')
        : `<div class="lib-empty">${term ? '没有匹配的提示词' : (selected ? '该分组还没有提示词' : '请先新建一个分组')}</div>`;
      panel.innerHTML = `
        <div class="lib-root">
          <div class="lib-head">
            <div class="lib-title">${icons.layers}<span>提示词库</span><small>按分组管理常用提示词，一键复制或标记使用</small></div>
            <div class="lib-head-actions">
              <input class="lib-search" id="lib-prompt-search" placeholder="搜索标题或内容…" value="${esc(term)}">
              <button type="button" class="btn lib-btn" data-act="pg-manage" title="新建/重命名/排序/删除分组">分组</button>
              <button type="button" class="btn primary lib-btn" data-act="prompt-new" ${selected ? '' : 'disabled'}>＋ 提示词</button>
            </div>
          </div>
          <div class="lib-chip-row">
            ${chips || '<span class="lib-muted">暂无分组</span>'}
            <button type="button" class="lib-chip lib-chip-add" data-act="pg-new" title="新建分组">${icons.plus} 分组</button>
          </div>
          <main class="lib-main lib-main-full">
            <div class="lib-main-head"><span class="lib-main-name">${selected ? esc(selected.name) : '未选择分组'}</span><span class="lib-muted">${shown.length} / ${sorted.length} 条提示词</span></div>
            <div class="lib-list">${cards}</div>
          </main>
        </div>`;
      bindPromptEvents(panel.querySelector('.lib-root'));
    }

    // 事件都绑在每次渲染新建的 .lib-root 上：root 随 host.innerHTML 重建被整体替换，
    // 监听器随之释放，不会在同一 host 上累积；不同面板（提示词/索引）也互不干扰。
    function bindPromptEvents(root) {
      const input = root.querySelector('#lib-prompt-search');
      if (input) input.addEventListener('input', () => { state.term = input.value; renderPrompts(); });
      root.addEventListener('keydown', (e) => {
        const group = e.target.closest('.lib-group');
        if (!group) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); group.click(); }
      });
      root.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act; const id = btn.dataset.id; const pos = Number(btn.dataset.pos || -1);
        try {
          if (act === 'pg-select') { state.groupId = id; renderPrompts(); }
          else if (act === 'pg-manage') openGroupManager();
          else if (act === 'pg-new') await promptForNewGroup();
          else if (act === 'pg-edit') await promptForRenameGroup(id);
          else if (act === 'pg-up' || act === 'pg-down') await moveGroup(pos, act === 'pg-up' ? -1 : 1);
          else if (act === 'pg-del') await deleteGroup(id);
          else if (act === 'prompt-new') await promptForPrompt(null);
          else if (act === 'prompt-edit') await promptForPrompt(id);
          else if (act === 'prompt-del') await deletePrompt(id);
          else if (act === 'prompt-copy') await copyPrompt(id);
          else if (act === 'prompt-use') await usePrompt(id);
        } catch (err) { toast(readError(err)); }
      });
    }

    /* ---------- 渲染：知识索引（AIassis 式：分类折叠分组 + markdown 详情视图） ---------- */
    function fmtDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    // 安全 URL：仅放行 http/https，其余按纯文本
    function safeHttpUrl(value) {
      const s = String(value || '').trim();
      if (!s) return '';
      try { const parsed = new URL(s); return /^https?:$/.test(parsed.protocol) ? s : ''; } catch { return ''; }
    }

    // 轻量 Markdown 渲染（内容先转义再结构化，防 XSS）
    function renderMarkdownLocal(md) {
      const inline = (text) => {
        let out = esc(text);
        out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
        out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
        out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
          const safe = safeHttpUrl(url);
          return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
        });
        return out;
      };
      const lines = String(md == null ? '' : md).split('\n');
      const out = [];
      let code = null;
      for (const raw of lines) {
        if (code !== null) {
          if (/^```/.test(raw)) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; }
          else code.push(raw);
          continue;
        }
        if (/^```/.test(raw)) { code = []; continue; }
        const heading = raw.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          const hashes = heading[1].length;
          const lvl = hashes >= 2 ? Math.min(hashes, 4) : 2; // #、## → h2；### → h3；#### → h4
          out.push(`<h${lvl}>${inline(heading[2])}</h${lvl}>`);
          continue;
        }
        if (/^-{3,}\s*$/.test(raw)) { out.push('<hr>'); continue; }
        if (/^>\s?/.test(raw)) { out.push(`<blockquote>${inline(raw.replace(/^>\s?/, ''))}</blockquote>`); continue; }
        if (/^\s*[-*]\s+/.test(raw)) { out.push(`<div class="md-li">• ${inline(raw.replace(/^\s*[-*]\s+/, ''))}</div>`); continue; }
        if (/^\s*\d+[.、)]\s+/.test(raw)) { out.push(`<div class="md-li">${inline(raw.replace(/^\s*\d+[.、)]\s+/, ''))}</div>`); continue; }
        const trimmed = raw.trim();
        if (trimmed) out.push(`<p>${inline(trimmed)}</p>`);
      }
      if (code !== null) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      return out.join('\n');
    }

    // 分类分组（含过滤）：categoryOrder 优先 + 新分类中文序补齐；空分类不展示
    function indexGroups() {
      const q = state.term.trim().toLowerCase();
      const visible = q
        ? state.entries.filter((e) => [e.title, e.content, e.category].some((f) => String(f || '').toLowerCase().includes(q)))
        : state.entries;
      const ordered = state.categories.filter((c) => visible.some((e) => e.category === c));
      const remaining = [...new Set(visible.map((e) => e.category).filter(Boolean))]
        .filter((c) => !ordered.includes(c)).sort((a, b) => a.localeCompare(b, 'zh'));
      return [...ordered, ...remaining].map((cat) => ({
        category: cat,
        entries: sortNumericAsc(visible.filter((e) => (e.category || '') === cat), 'order'),
      })).filter((g) => g.entries.length > 0);
    }

    function renderIndexDetail(entry) {
      const panel = state.hostEl;
      if (!panel) return;
      const sourceLabel = entry.source === 'obsidian' ? 'Obsidian' : '手动';
      const sourceCls = entry.source === 'obsidian' ? 'lib-src-obsidian' : 'lib-src-manual';
      panel.innerHTML = `
        <div class="lib-root">
          <div class="idx-detail-head">
            <button type="button" class="btn lib-btn" data-act="idx-back" title="返回列表">← 返回</button>
            <span class="lib-chip-static">${esc(entry.category || '未分类')}</span>
            <div class="idx-detail-title" title="${esc(entry.title)}">${esc(entry.title)}</div>
            <span class="idx-detail-ops">
              <button type="button" class="lib-mini" data-act="idx-copy" data-id="${esc(entry.id)}" title="复制条目">${icons.copy}</button>
              <button type="button" class="lib-mini" data-act="idx-edit" data-id="${esc(entry.id)}" title="编辑">${icons.edit}</button>
              <button type="button" class="lib-mini lib-danger" data-act="idx-del" data-id="${esc(entry.id)}" title="删除">${icons.trash}</button>
            </span>
          </div>
          <div class="idx-detail-meta">
            <span class="lib-src ${sourceCls}">${sourceLabel}</span>
            <span>${entry.source === 'obsidian' && entry.sourcePath ? '· ' + esc(entry.sourcePath) : ''}</span>
            <span class="lib-muted">更新 ${fmtDate(entry.updatedAt || entry.createdAt)}</span>
          </div>
          <div class="md-body">${entry.content ? renderMarkdownLocal(entry.content) : '<span class="lib-muted">（无内容）</span>'}</div>
        </div>`;
      bindIndexEvents(panel.querySelector('.lib-root'));
    }

    function renderIndex() {
      const panel = state.hostEl;
      if (!panel) return;
      const detailEntry = state.indexView === 'detail' && state.detailId
        ? state.entries.find((x) => x.id === state.detailId) : null;
      if (detailEntry) { renderIndexDetail(detailEntry); return; }

      const groups = indexGroups();
      const q = state.term.trim();
      const catSections = groups.length
        ? groups.map((g) => {
          const collapsed = state.collapsed.has(g.category);
          const rows = g.entries.map((entry) => {
            const sourceLabel = entry.source === 'obsidian' ? 'Obsidian' : '手动';
            const sourceCls = entry.source === 'obsidian' ? 'lib-src-obsidian' : 'lib-src-manual';
            return `<div class="idx-entry" data-act="idx-open" data-id="${esc(entry.id)}" title="查看详情">
              <span class="idx-entry-title">${esc(entry.title) || '<span class="lib-muted">（无标题）</span>'}</span>
              <span class="lib-src ${sourceCls}">${sourceLabel}</span>
              <button type="button" class="lib-mini lib-danger" data-act="idx-del" data-id="${esc(entry.id)}" title="删除">${icons.trash}</button>
            </div>`;
          }).join('');
          return `<section class="idx-cat" data-cat="${esc(g.category)}">
            <div class="idx-cat-head" role="button" tabindex="0" data-act="idx-cat-toggle" data-cat="${esc(g.category)}" title="${collapsed ? '展开' : '折叠'}分类">
              <span class="idx-cat-arrow">${collapsed ? '▸' : '▾'}</span>
              <span class="idx-cat-name">${esc(g.category)}</span>
              <span class="lib-group-cnt">${g.entries.length}</span>
            </div>
            ${collapsed ? '' : `<div class="idx-entries">${rows}</div>`}
          </section>`;
        }).join('')
        : `<div class="lib-empty">${q ? '没有匹配的条目' : '还没有索引条目，点右上角「＋ 新建条目」开始收录'}</div>`;

      panel.innerHTML = `
        <div class="lib-root">
          <div class="lib-head">
            <div class="lib-title">${icons.folder}<span>知识索引</span><small>分类收录资料、链接与片段（${state.entries.length}/${LIMITS.maxEntries}）</small></div>
            <div class="lib-head-actions">
              <input class="lib-search" id="lib-index-search" placeholder="搜索标题或内容…" value="${esc(state.term)}">
              <button type="button" class="btn lib-btn" data-act="idx-import" title="从本地 markdown 目录批量导入">导入</button>
              <button type="button" class="btn primary lib-btn" data-act="idx-new">＋ 新建条目</button>
            </div>
          </div>
          <main class="lib-main lib-main-full idx-list">${catSections}</main>
        </div>`;
      bindIndexEvents(panel.querySelector('.lib-root'));
    }

    function bindIndexEvents(root) {
      const input = root.querySelector('#lib-index-search');
      if (input) input.addEventListener('input', () => { state.term = input.value; renderIndex(); });
      root.addEventListener('keydown', (e) => {
        const head = e.target.closest('.idx-cat-head');
        if (!head) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); }
      });
      root.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act; const id = btn.dataset.id; const cat = btn.dataset.cat;
        try {
          if (act === 'idx-back') { state.indexView = 'list'; state.detailId = null; renderIndex(); }
          else if (act === 'idx-open') { state.indexView = 'detail'; state.detailId = id; renderIndex(); }
          else if (act === 'idx-cat-toggle') {
            if (state.collapsed.has(cat)) state.collapsed.delete(cat); else state.collapsed.add(cat);
            renderIndex();
          }
          else if (act === 'idx-import') openIndexImport();
          else if (act === 'idx-new') await promptForEntry(null);
          else if (act === 'idx-edit') await promptForEntry(id);
          else if (act === 'idx-del') await deleteEntry(id);
          else if (act === 'idx-copy') await copyEntry(id);
        } catch (err) { toast(readError(err)); }
      });
    }

    /* ---------- 提示词库动作 ---------- */
    async function promptForNewGroup() {
      const values = await openForm('新建分组', [
        { key: 'name', label: '分组名', type: 'text', max: LIMITS.groupName, placeholder: '例如：代码审查 / 文案写作', required: true },
      ], { submitText: '创建' });
      if (values == null) return;
      await http('/api/prompt-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: values.name }) });
      await listPrompts(); renderPrompts(); toast('分组已创建');
    }
    async function promptForRenameGroup(id) {
      const group = state.groups.find((x) => x.id === id); if (!group) return;
      const values = await openForm('重命名分组', [
        { key: 'name', label: '分组名', type: 'text', max: LIMITS.groupName, value: group.name, required: true },
      ], { submitText: '保存' });
      if (values == null) return;
      await http('/api/prompt-groups/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: values.name }) });
      await listPrompts(); renderPrompts(); toast('已重命名');
    }
    async function moveGroup(pos, dir) {
      const groups = sortNumericAsc(state.groups, 'sort_order');
      const target = pos + dir;
      if (target < 0 || target >= groups.length) return;
      const a = groups[pos]; const b = groups[target];
      const aOrder = Number(a.sort_order) || 0; const bOrder = Number(b.sort_order) || 0;
      if (aOrder === bOrder) return;
      const patches = [
        { id: a.id, sort_order: bOrder },
        { id: b.id, sort_order: aOrder },
      ];
      await Promise.all(patches.map((p) => http('/api/prompt-groups/' + encodeURIComponent(p.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sort_order: p.sort_order }) })));
      await listPrompts(); renderPrompts();
    }
    async function deleteGroup(id) {
      const group = state.groups.find((x) => x.id === id); if (!group) return;
      const count = state.prompts.filter((p) => p.group_id === id).length;
      if (!window.confirm(`删除分组「${group.name}」${count ? `及其 ${count} 条提示词` : ''}？删除后无法恢复。`)) return;
      await http('/api/prompt-groups/' + encodeURIComponent(id), { method: 'DELETE' });
      await listPrompts(); renderPrompts(); toast('分组已删除');
    }
    async function promptForPrompt(id) {
      const item = id ? state.prompts.find((x) => x.id === id) : null;
      if (id && !item) return;
      const groups = sortNumericAsc(state.groups, 'sort_order');
      const form = [
        { key: 'title', label: '标题', type: 'text', max: LIMITS.promptTitle, value: item?.title || '', required: true, placeholder: '一句话描述这个提示词的用途' },
        { key: 'group_id', label: '所属分组', type: 'select', value: item?.group_id || state.groupId, required: true, options: groups.map((g) => ({ value: g.id, label: g.name })) },
        { key: 'content', label: '内容', type: 'textarea', max: LIMITS.promptContent, value: item?.content || '', placeholder: '提示词正文…', help: `不超过 ${LIMITS.promptContent} 字` },
      ];
      const values = await openForm(id ? '编辑提示词' : '新建提示词', form, { submitText: id ? '保存' : '创建' });
      if (values == null) return;
      const body = { title: values.title, content: values.content, group_id: values.group_id };
      if (id) {
        await http('/api/prompts/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        await http('/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }
      state.groupId = values.group_id;
      await listPrompts(); renderPrompts(); toast(id ? '已保存' : '提示词已创建');
    }
    async function deletePrompt(id) {
      const item = state.prompts.find((x) => x.id === id); if (!item) return;
      if (!window.confirm(`删除提示词「${item.title || '（无标题）'}」？删除后无法恢复。`)) return;
      await http('/api/prompts/' + encodeURIComponent(id), { method: 'DELETE' });
      await listPrompts(); renderPrompts(); toast('提示词已删除');
    }
    async function copyPrompt(id) {
      const item = state.prompts.find((x) => x.id === id); if (!item) return;
      await copyText(item.content || '');
      if (item.content) toast('已复制到剪贴板');
    }
    async function usePrompt(id) {
      await http('/api/prompts/' + encodeURIComponent(id) + '/use', { method: 'POST' });
      await listPrompts(); renderPrompts(); toast('已标记使用');
    }

    /* ---------- 知识索引动作 ---------- */
    async function promptForEntry(id) {
      const item = id ? state.entries.find((x) => x.id === id) : null;
      if (id && !item) return;
      const cats = state.categories.slice();
      const form = [
        { key: 'title', label: '标题', type: 'text', max: LIMITS.entryTitle, value: item?.title || '', required: true, placeholder: '要收藏的内容标题' },
        { key: 'category', label: '分类', type: 'text', max: LIMITS.category, value: item?.category || state.category || '', required: true, placeholder: '输入已有或新的分类名', datalist: cats, help: '可直接输入新分类名，会自动创建' },
        { key: 'content', label: '内容', type: 'textarea', max: LIMITS.entryContent, value: item?.content || '', placeholder: '正文、链接或要点…', help: `不超过 ${LIMITS.entryContent} 字` },
      ];
      const values = await openForm(id ? '编辑条目' : '新建索引条目', form, { submitText: id ? '保存' : '创建' });
      if (values == null) return;
      const body = { title: values.title, category: values.category, content: values.content };
      if (id) {
        await http('/api/index-entries/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        await http('/api/index-entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }
      state.category = values.category;
      await listIndex(); renderIndex(); toast(id ? '已保存' : '条目已收录');
    }
    async function deleteEntry(id) {
      const item = state.entries.find((x) => x.id === id); if (!item) return;
      if (!window.confirm(`删除条目「${item.title || '（无标题）'}」？删除后无法恢复。`)) return;
      await http('/api/index-entries/' + encodeURIComponent(id), { method: 'DELETE' });
      await listIndex(); renderIndex(); toast('条目已删除');
    }
    async function copyEntry(id) {
      const item = state.entries.find((x) => x.id === id); if (!item) return;
      const body = `${item.title}\n${item.content || ''}`.trim();
      await copyText(body);
      if (body) toast('已复制到剪贴板');
    }

    // 从本地 markdown 目录导入（调用后端 /api/index/import，source=obsidian）
    function openIndexImport() {
      const { body, close } = makeModal({ title: '从目录导入 markdown' });
      body.innerHTML = `
        <div class="lib-field"><span class="lib-field-label">目录路径</span>
          <input id="idx-imp-dir" type="text" placeholder="例如 F:////obsidian 或 E:////notes" autocomplete="off" spellcheck="false">
          <small class="lib-field-help">递归扫描该目录下的 *.md；已导入过的文件（按绝对路径）会自动更新</small></div>
        <div class="lib-field"><span class="lib-field-label">分类（留空=按目录名）</span>
          <input id="idx-imp-cat" type="text" placeholder="留空时用目录名 / 子目录名作为分类" autocomplete="off" spellcheck="false"></div>
        <label class="lib-check"><input id="idx-imp-recursive" type="checkbox" checked> 包含子目录</label>
        <div class="lib-form-error" id="idx-imp-err" hidden></div>
        <div class="lib-modal-actions">
          <button type="button" class="btn" data-cancel>取消</button>
          <button type="button" class="btn primary" data-run>开始导入</button>
        </div>`;
      const errBox = body.querySelector('#idx-imp-err');
      const runBtn = body.querySelector('[data-run]');
      const run = async () => {
        const dir = body.querySelector('#idx-imp-dir').value.trim();
        runBtn.disabled = true; runBtn.textContent = '导入中…';
        try {
          if (!dir) throw new Error('请输入目录路径');
          const res = await http('/api/index/import', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              dir,
              category: body.querySelector('#idx-imp-cat').value.trim(),
              recursive: body.querySelector('#idx-imp-recursive').checked,
            }),
          });
          const summary = `导入完成：新增 ${res.imported} · 更新 ${res.updated} · 跳过 ${res.skipped}（目录内 ${res.total} 个 markdown）`;
          if (res.errors && res.errors.length) {
            errBox.textContent = `${summary}\n失败 ${res.errors.length} 个：${res.errors.join('；')}`;
            errBox.hidden = false;
            runBtn.disabled = false; runBtn.textContent = '重试导入';
          } else {
            close(); toast(summary);
            await listIndex(); renderIndex();
          }
        } catch (error) {
          errBox.textContent = readError(error); errBox.hidden = false;
          runBtn.disabled = false; runBtn.textContent = '开始导入';
        }
      };
      body.querySelector('[data-run]').addEventListener('click', run);
      body.querySelector('[data-cancel]').addEventListener('click', close);
      body.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void run(); } });
      const dirInput = body.querySelector('#idx-imp-dir'); dirInput.focus();
    }
    async function moveEntry(pos, dir) {
      const term = state.term;
      const filtered = filterText(state.entries, term, ['title', 'content', 'category']);
      const byCat = state.category ? filtered.filter((x) => x.category === state.category) : filtered;
      const sorted = sortNumericAsc(byCat, 'order');
      const target = pos + dir;
      if (target < 0 || target >= sorted.length) return;
      const a = sorted[pos]; const b = sorted[target];
      const aOrder = Number(a.order) || 0; const bOrder = Number(b.order) || 0;
      if (aOrder === bOrder) return;
      await Promise.all([
        http('/api/index-entries/' + encodeURIComponent(a.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: bOrder }) }),
        http('/api/index-entries/' + encodeURIComponent(b.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: aOrder }) }),
      ]);
      await listIndex(); renderIndex();
    }

    /* ---------- 通用：分组管理弹窗（在 makeModal 之上） ---------- */
    function openGroupManager() {
      const groups = sortNumericAsc(state.groups, 'sort_order');
      const { body, close } = makeModal({ title: `管理分组（${groups.length}/${LIMITS.maxGroups}）` });
      const rows = groups.length
        ? groups.map((g, gi) => {
          const n = state.prompts.filter((p) => p.group_id === g.id).length;
          return `<div class="lib-mgr-row" data-id="${esc(g.id)}">
            <span class="lib-mgr-name" title="${esc(g.name)}">${esc(g.name)}</span>
            <span class="lib-group-cnt">${n}</span>
            <span class="lib-mgr-ops">
              <button type="button" class="lib-mini" data-mgr="up" data-pos="${gi}" title="上移" ${gi === 0 ? 'disabled' : ''}>${icons.up}</button>
              <button type="button" class="lib-mini" data-mgr="down" data-pos="${gi}" title="下移" ${gi >= groups.length - 1 ? 'disabled' : ''}>${icons.down}</button>
              <button type="button" class="lib-mini" data-mgr="rename" title="重命名">${icons.edit}</button>
              <button type="button" class="lib-mini lib-danger" data-mgr="delete" title="删除分组（连同其中提示词）">${icons.trash}</button>
            </span>
          </div>`;
        }).join('')
        : '<div class="lib-empty">暂无分组</div>';
      body.innerHTML = `
        <div class="lib-mgr-list">${rows}</div>
        <div class="lib-mgr-foot">
          <button type="button" class="btn primary" data-mgr="new">＋ 新建分组</button>
          <button type="button" class="btn" data-mgr="done">完成</button>
        </div>`;
      body.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-mgr]');
        if (!btn || btn.disabled) return;
        const row = btn.closest('[data-id]');
        const id = row?.dataset.id;
        const pos = Number(btn.dataset.pos);
        try {
          const mgr = btn.dataset.mgr;
          if (mgr === 'new') { close(); await promptForNewGroup(); }
          else if (mgr === 'done') { close(); }
          else if (mgr === 'rename') { close(); await promptForRenameGroup(id); }
          else if (mgr === 'delete') { close(); await deleteGroup(id); }
          else if (mgr === 'up' || mgr === 'down') { await moveGroup(pos, mgr === 'up' ? -1 : 1); close(); openGroupManager(); }
        } catch (err) { toast(readError(err)); }
      });
    }

    /* ---------- 通用：剪贴板 / 弹窗表单 ---------- */
    // makeModal：通用弹窗骨架，body 由调用方填充并自行绑定交互
    function makeModal({ title, width = '' } = {}) {
      const mask = dom().el('div', { class: 'lib-modal-mask' });
      const node = dom().el('div', { class: 'lib-modal' });
      if (width) node.style.width = width;
      node.innerHTML = `
        <div class="lib-modal-head"><h3>${esc(title)}</h3><button type="button" class="lib-mini" data-x title="关闭">${icons.close}</button></div>
        <div class="lib-modal-body"></div>`;
      mask.appendChild(node);
      document.body.appendChild(mask);
      const body = node.querySelector('.lib-modal-body');
      const close = () => mask.remove();
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
      node.querySelector('[data-x]').addEventListener('click', close);
      return { mask, node, body, close };
    }

    async function copyText(value) {
      const s = String(value || '');
      if (!s) { toast('内容为空'); return; }
      try {
        if (navigator.clipboard && window.isSecureContext !== false) { await navigator.clipboard.writeText(s); return; }
      } catch { /* fallthrough */ }
      const helper = document.createElement('textarea');
      helper.value = s; helper.style.position = 'fixed'; helper.style.opacity = '0';
      document.body.appendChild(helper); helper.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(helper); }
    }

    // openForm：返回字段值对象；用户取消返回 null
    function openForm(title, fields, options = {}) {
      return new Promise((resolve) => {
        const mask = dom().el('div', { class: 'lib-modal-mask' });
        const node = dom().el('div', { class: 'lib-modal' });
        const fieldHtml = fields.map((f) => {
          let control = '';
          if (f.type === 'select') {
            const opts = (f.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
            control = `<select data-key="${f.key}" ${f.required ? 'required' : ''}>${opts}</select>`;
          } else if (f.type === 'textarea') {
            control = `<textarea data-key="${f.key}" rows="8" maxlength="${f.max || ''}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}>${esc(f.value || '')}</textarea>`;
          } else {
            const listId = f.datalist ? `dl-${f.key}` : '';
            const dl = f.datalist ? `<datalist id="${listId}">${f.datalist.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>` : '';
            control = `<input data-key="${f.key}" type="text" maxlength="${f.max || ''}" list="${listId}" placeholder="${esc(f.placeholder || '')}" value="${esc(f.value || '')}" ${f.required ? 'required' : ''}>${dl}`;
          }
          return `<label class="lib-field"><span class="lib-field-label">${esc(f.label)}</span>${control}${f.help ? `<small class="lib-field-help">${esc(f.help)}</small>` : ''}</label>`;
        }).join('');
        node.innerHTML = `
          <div class="lib-modal-head"><h3>${esc(title)}</h3><button type="button" class="lib-mini" data-x title="关闭">${icons.close}</button></div>
          <form class="lib-modal-form">${fieldHtml}<div class="lib-form-error" hidden></div>
            <div class="lib-modal-actions">
              <button type="button" class="btn" data-cancel>取消</button>
              <button type="submit" class="btn primary">${esc(options.submitText || '保存')}</button>
            </div>
          </form>`;
        mask.appendChild(node);
        document.body.appendChild(mask);
        const input = node.querySelector('input, select, textarea');
        if (input) input.focus();

        const close = (result) => { mask.remove(); resolve(result); };
        mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null); });
        node.querySelector('[data-x]').addEventListener('click', () => close(null));
        node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
        node.querySelector('form').addEventListener('submit', (e) => {
          e.preventDefault();
          const errorBox = node.querySelector('.lib-form-error');
          const values = {};
          for (const f of fields) {
            const control = node.querySelector(`[data-key="${f.key}"]`);
            const raw = control ? control.value : '';
            if (f.type !== 'textarea') {
              const cleaned = String(raw).trim();
              if (f.required && !cleaned) { showError(`请填写${f.label}`); return; }
              if (f.max && cleaned.length > f.max) { showError(`${f.label}长度不能超过 ${f.max} 个字符`); return; }
              values[f.key] = cleaned;
            } else {
              if (f.max && raw.length > f.max) { showError(`${f.label}长度不能超过 ${f.max} 个字符`); return; }
              values[f.key] = raw;
            }
          }
          close(values);
          function showError(msg) { errorBox.textContent = msg; errorBox.hidden = false; }
        });
      });
    }

    /* ---------- 入口 ---------- */
    // renderInto(mode, hostEl)：把面板渲染进外部容器（Todo 抽屉/主区面板），
    // hostEl 缺省时回退到 index.html 里的 #prompts-panel / #index-panel。
    function renderInto(mode, hostEl) {
      state.mode = mode === 'index' ? 'index' : 'prompts';
      if (state.mode === 'index') { state.indexView = 'list'; state.detailId = null; }
      state.hostEl = hostEl || document.getElementById(mode === 'index' ? 'index-panel' : 'prompts-panel') || null;
      if (!state.hostEl) return Promise.resolve();
      const renderMode = state.mode;
      // 2026-09-07：包 try-catch 渲染错误占位，避免 listPrompts/listIndex 抛错时面板空白。
      // 之前 throw 会让 host 保持空字符串 / 上次内容（残留），用户看到"添加后消失"。
      return (renderMode === 'index' ? listIndex() : listPrompts())
        .then(() => { if (state.hostEl) (renderMode === 'index' ? renderIndex() : renderPrompts()); })
        .catch((err) => {
          if (!state.hostEl) return;
          const msg = (err && err.message) || String(err || '加载失败');
          state.hostEl.innerHTML = `
            <div class="lib-root">
              <div class="lib-head"><div class="lib-title">${icons.layers}<span>${renderMode === 'index' ? '知识索引' : '提示词库'}</span></div></div>
              <div class="lib-empty"><strong>加载失败</strong>${esc(msg)}<br><button type="button" class="btn primary lib-btn" data-act="retry-${renderMode}" style="margin-top:10px">重试</button></div>
            </div>`;
          const retryBtn = state.hostEl.querySelector(`[data-act="retry-${renderMode}"]`);
          if (retryBtn) retryBtn.addEventListener('click', () => { state.hostEl.innerHTML = ''; return renderInto(renderMode, state.hostEl); });
          try { toast(`加载失败：${msg}`); } catch { /* ignore */ }
        });
    }
    function show(mode) {
      state.term = '';
      return renderInto(mode, null);
    }

    return { show, renderInto, refresh };
  }

  const api = { createLibraryPanels, LIMITS, sortNumericAsc, filterText, checkLength };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentBoardLibraryUi = api;
})(typeof window === 'object' ? window : globalThis);
