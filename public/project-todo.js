'use strict';

(function exposeProjectTodo(root) {
  const DEFAULT_WIDTH = 320;
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 480;
  const OPEN_DELAY_MS = 80;
  const CLOSE_DELAY_MS = 300;
  const TODO_CACHE_TTL_MS = 30 * 1000;
  const WIDTH_KEY = 'agentBoard.todoDrawer.width';
  const PINNED_KEY = 'agentBoard.todoDrawer.pinned';
  const HOVER_KEY = 'agentBoard.todoDrawer.hoverEnabled';
  const HIDE_COMPLETED_KEY = 'agentBoard.todoDrawer.hideCompleted';

  function safeStorage() {
    try { return window.localStorage; } catch { return null; }
  }

  function readBoolean(storage, key, fallback) {
    const value = storage?.getItem(key);
    return value == null ? fallback : value === '1';
  }

  function clampWidth(value) {
    if (value == null || value === '') return DEFAULT_WIDTH;
    const width = Number(value);
    return Number.isFinite(width) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)) : DEFAULT_WIDTH;
  }

  function icon(name) {
    const paths = {
      pin: '<path d="m15 4 5 5-3 1-3 5-2-2-5 5-1-1 5-5-2-2 5-3 1-3Z"/><path d="m9 15-4 4"/>',
      close: '<path d="m6 6 12 12M18 6 6 18"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      chevron: '<path d="m9 6 6 6-6 6"/>',
      edit: '<path d="m4 16-.8 4.8L8 20l10.7-10.7a2.1 2.1 0 0 0-3-3L4 16Z"/><path d="m14.5 7.5 2 2"/>',
      trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    };
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
  }

  function createProjectTodoDrawer({ requestJson, escapeHtml, notify } = {}) {
    if (typeof requestJson !== 'function') throw new TypeError('Project Todo drawer requires requestJson');
    const esc = typeof escapeHtml === 'function' ? escapeHtml : (value) => String(value ?? '');
    const storage = safeStorage();
    const state = {
      mode: readBoolean(storage, PINNED_KEY, false) ? 'pinned' : 'hidden',
      tasks: [],
      expanded: new Set(),
      loading: false,
      loaded: false,
      hoverEnabled: readBoolean(storage, HOVER_KEY, true),
      hideCompleted: readBoolean(storage, HIDE_COMPLETED_KEY, false),
      width: clampWidth(storage?.getItem(WIDTH_KEY)),
      interactionLocked: false,
      editing: null,
      addingSubtask: null,
    };
    let openTimer = null;
    let closeTimer = null;
    let requestSerial = 0;
    let refreshPromise = null;
    let lastLoadedAt = 0;
    let childrenIndex = new Map();
    let pointerInside = false;
    let resizeSession = null;

    const shell = document.createElement('div');
    shell.innerHTML = `
      <button class="todo-edge-trigger" type="button" aria-label="打开 Todo 清单" title="打开 Todo 清单"></button>
      <aside class="todo-drawer" data-mode="hidden" aria-label="Todo 清单面板">
        <header class="todo-panel-head">
          <div class="todo-panel-title"><h2>Todo 清单</h2><div class="todo-panel-project">手动添加的全局任务</div></div>
          <div class="todo-panel-actions">
            <button class="todo-panel-btn" type="button" data-action="pin" aria-label="固定 Todo 面板" title="固定 Todo 面板">${icon('pin')}</button>
            <button class="todo-panel-btn" type="button" data-action="close" aria-label="关闭 Todo 面板" title="关闭 Todo 面板">${icon('close')}</button>
          </div>
        </header>
        <div class="todo-progress">
          <div class="todo-progress-line"><strong data-role="progress-label">0 / 0 已完成</strong><span data-role="progress-percent">0%</span></div>
          <div class="todo-progress-track"><div class="todo-progress-fill" data-role="progress-fill" style="width:0%"></div></div>
        </div>
        <div class="todo-toolbar">
          <label><input type="checkbox" data-action="hover-enabled">边缘悬停展开</label>
          <label><input type="checkbox" data-action="hide-completed">隐藏已完成</label>
          <span>Alt+Q 呼出</span>
        </div>
        <div class="todo-list" data-role="list"></div>
        <form class="todo-quick-add" data-role="quick-add">
          <input class="todo-quick-input" data-role="quick-input" placeholder="添加任务…" maxlength="500" aria-label="添加任务">
          <button class="todo-task-action" type="submit" data-action="quick-add" aria-label="添加任务" title="添加任务">${icon('plus')}</button>
        </form>
        <div class="todo-drawer-resize" data-role="resize" role="separator" aria-orientation="vertical" aria-valuemin="280" aria-valuemax="480" aria-valuenow="320" tabindex="0" aria-label="调整 Todo 面板宽度"></div>
      </aside>`;
    document.body.appendChild(shell);

    const trigger = shell.querySelector('.todo-edge-trigger');
    const drawer = shell.querySelector('.todo-drawer');
    const list = shell.querySelector('[data-role="list"]');
    const progressLabel = shell.querySelector('[data-role="progress-label"]');
    const progressPercent = shell.querySelector('[data-role="progress-percent"]');
    const progressFill = shell.querySelector('[data-role="progress-fill"]');
    const hoverEnabled = shell.querySelector('[data-action="hover-enabled"]');
    const hideCompleted = shell.querySelector('[data-action="hide-completed"]');
    const quickForm = shell.querySelector('[data-role="quick-add"]');
    const quickInput = shell.querySelector('[data-role="quick-input"]');
    const resizeHandle = shell.querySelector('[data-role="resize"]');

    function tell(message) {
      if (typeof notify === 'function') notify(message);
      else if (typeof window.toast === 'function') window.toast(message);
    }

    function save(key, value) {
      try { storage?.setItem(key, value); } catch {}
    }

    function clearTimers() {
      clearTimeout(openTimer); clearTimeout(closeTimer);
      openTimer = null; closeTimer = null;
    }

    function applyMode() {
      drawer.dataset.mode = state.mode;
      drawer.style.setProperty('--todo-width', `${state.width}px`);
      resizeHandle.setAttribute('aria-valuenow', String(Math.round(state.width)));
      const pinButton = shell.querySelector('[data-action="pin"]');
      pinButton.classList.toggle('active', state.mode === 'pinned');
      pinButton.setAttribute('aria-label', state.mode === 'pinned' ? '取消固定 Todo 面板' : '固定 Todo 面板');
      pinButton.title = state.mode === 'pinned' ? '取消固定 Todo 面板' : '固定 Todo 面板';
    }

    function setMode(mode) {
      clearTimers();
      if (mode === 'hidden' && state.editing) finishEdit(false);
      state.mode = mode;
      if (mode === 'pinned') save(PINNED_KEY, '1');
      if (mode === 'hidden') save(PINNED_KEY, '0');
      applyMode();
      if (mode !== 'hidden') void refresh();
    }

    function scheduleClose() {
      clearTimeout(closeTimer);
      if (state.mode !== 'peek' || state.loading || pointerInside || state.interactionLocked || state.editing || state.addingSubtask) return;
      closeTimer = setTimeout(() => setMode('hidden'), CLOSE_DELAY_MS);
    }

    function scheduleOpen() {
      if (!state.hoverEnabled || state.mode === 'pinned' || state.mode === 'peek') return;
      clearTimeout(openTimer);
      openTimer = setTimeout(() => setMode('peek'), OPEN_DELAY_MS);
    }

    function setWidth(width, persist = false) {
      state.width = clampWidth(width);
      applyMode();
      if (persist) save(WIDTH_KEY, String(Math.round(state.width)));
    }

    function stopResize() {
      if (!resizeSession) return;
      resizeSession = null;
      document.body.style.removeProperty('user-select');
      state.interactionLocked = false;
      save(WIDTH_KEY, String(Math.round(state.width)));
      scheduleClose();
    }

    function rebuildTaskIndexes() {
      childrenIndex = new Map();
      for (const task of state.tasks) {
        if (!task.parent_id) continue;
        const children = childrenIndex.get(task.parent_id) || [];
        children.push(task);
        childrenIndex.set(task.parent_id, children);
      }
      for (const children of childrenIndex.values()) {
        children.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
      }
    }

    function childrenFor(parentId) {
      return childrenIndex.get(parentId) || [];
    }

    function visibleTasks() {
      return state.tasks.filter((task) => !task.parent_id && !(state.hideCompleted && task.is_completed));
    }

    function taskHidden(task) {
      return state.hideCompleted && task.is_completed;
    }

    function progress() {
      const topLevel = state.tasks.filter((task) => !task.parent_id);
      const completed = topLevel.filter((task) => task.is_completed).length;
      return { completed, total: topLevel.length, percent: topLevel.length ? Math.round((completed / topLevel.length) * 100) : 0 };
    }

    function editingInput(task) {
      if (state.editing?.id !== task.id) return `<span class="todo-task-title" title="${esc(task.title)}">${esc(task.title)}</span>`;
      return `<input class="todo-inline-input" data-edit-input data-task-id="${esc(task.id)}" value="${esc(task.title)}" maxlength="500" aria-label="编辑任务">`;
    }

    function actionButtons(task, isParent) {
      const add = isParent ? `<button class="todo-task-action" type="button" data-action="add-subtask" data-task-id="${esc(task.id)}" aria-label="添加子任务" title="添加子任务">${icon('plus')}</button>` : '';
      return `${add}<button class="todo-task-action" type="button" data-action="edit" data-task-id="${esc(task.id)}" aria-label="编辑任务" title="编辑任务">${icon('edit')}</button><button class="todo-task-action" type="button" data-action="delete" data-task-id="${esc(task.id)}" aria-label="删除任务" title="删除任务">${icon('trash')}</button>`;
    }

    function renderChild(task) {
      if (taskHidden(task)) return '';
      const checked = task.is_completed ? ' checked' : '';
      return `<div class="todo-subtask ${task.is_completed ? 'done' : ''}" data-task-id="${esc(task.id)}">
        <input class="todo-task-check" type="checkbox" data-action="toggle" data-task-id="${esc(task.id)}" aria-label="完成 ${esc(task.title)}"${checked}>
        <div class="todo-task-main">${editingInput(task)}</div>
        <div class="todo-task-actions">${actionButtons(task, false)}</div>
      </div>`;
    }

    function renderParent(task) {
      const children = childrenFor(task.id);
      const shownChildren = children.filter((child) => !taskHidden(child));
      const hasPartial = children.some((child) => child.is_completed) && !children.every((child) => child.is_completed);
      const expanded = state.expanded.has(task.id);
      const checked = task.is_completed ? ' checked' : '';
      const indeterminate = hasPartial ? ' data-indeterminate="1"' : '';
      const childMarkup = expanded ? `${shownChildren.map(renderChild).join('')}${state.addingSubtask === task.id ? `<div class="todo-subtask-add"><input class="todo-inline-input" data-subtask-input data-parent-id="${esc(task.id)}" maxlength="500" placeholder="添加子任务…" aria-label="添加子任务"><button class="todo-task-action" type="button" data-action="cancel-add" data-task-id="${esc(task.id)}" aria-label="取消添加">${icon('close')}</button></div>` : ''}` : '';
      return `<div class="todo-task ${task.is_completed ? 'done' : ''}" data-task-id="${esc(task.id)}">
        <div class="todo-task-row">
          <button class="todo-task-expand" type="button" data-action="expand" data-task-id="${esc(task.id)}" aria-label="${expanded ? '收起' : '展开'}子任务" aria-expanded="${expanded}" ${children.length ? '' : 'disabled'}>${icon('chevron')}</button>
          <input class="todo-task-check" type="checkbox" data-action="toggle" data-task-id="${esc(task.id)}" aria-label="完成 ${esc(task.title)}"${checked}${indeterminate}>
          <div class="todo-task-main">${editingInput(task)}</div>
          <div class="todo-task-actions">${actionButtons(task, true)}</div>
        </div>
        ${expanded ? `<div class="todo-subtasks">${childMarkup || '<div class="todo-empty" style="padding:8px">暂无子任务</div>'}</div>` : ''}
      </div>`;
    }

    function render() {
      hoverEnabled.checked = state.hoverEnabled;
      hideCompleted.checked = state.hideCompleted;
      const { completed, total, percent } = progress();
      progressLabel.textContent = `${completed} / ${total} 已完成`;
      progressPercent.textContent = `${percent}%`;
      progressFill.style.width = `${percent}%`;
      if (state.loading) {
        list.innerHTML = '<div class="todo-empty">正在加载任务…</div>';
      } else {
        const items = visibleTasks();
        list.innerHTML = items.length
          ? items.map(renderParent).join('')
          : '<div class="todo-empty"><strong>暂无任务</strong>从下方输入框手动添加第一个 Todo。</div>';
      }
      list.querySelectorAll('[data-indeterminate="1"]').forEach((checkbox) => { checkbox.indeterminate = true; });
      applyMode();
      focusPendingInput();
    }

    function focusPendingInput() {
      const input = state.editing
        ? list.querySelector(`[data-edit-input][data-task-id="${CSS.escape(state.editing.id)}"]`)
        : list.querySelector(`[data-subtask-input][data-parent-id="${CSS.escape(state.addingSubtask || '')}"]`);
      if (!input) return;
      input.focus();
      input.select();
    }

    function refresh({ force = false } = {}) {
      if (!force && state.loaded && Date.now() - lastLoadedAt < TODO_CACHE_TTL_MS) {
        return Promise.resolve(state.tasks);
      }
      if (refreshPromise) {
        return force ? refreshPromise.then(() => refresh({ force: true })) : refreshPromise;
      }
      const serial = ++requestSerial;
      state.loading = !state.loaded;
      render();
      const request = requestJson('/api/todos')
        .then((data) => {
          if (serial !== requestSerial) return state.tasks;
          state.tasks = Array.isArray(data.items) ? data.items : [];
          rebuildTaskIndexes();
          state.loaded = true;
          lastLoadedAt = Date.now();
          return state.tasks;
        })
        .catch((error) => {
          if (serial === requestSerial) tell(`Todo 加载失败：${error.message || '请求失败'}`);
          return state.tasks;
        });
      refreshPromise = request.finally(() => {
        if (refreshPromise === trackedRequest) refreshPromise = null;
        if (serial === requestSerial) { state.loading = false; render(); }
      });
      const trackedRequest = refreshPromise;
      return trackedRequest;
    }

    async function mutate(action, successMessage) {
      try {
        await action();
        state.editing = null; state.addingSubtask = null;
        await refresh({ force: true });
        if (successMessage) tell(successMessage);
      } catch (error) {
        tell(`Todo 操作失败：${error.message || '请求失败'}`);
        render();
      }
    }

    function finishEdit(saveChanges) {
      const editing = state.editing;
      state.editing = null;
      if (!editing) return;
      if (!saveChanges) { render(); return; }
      const input = list.querySelector(`[data-edit-input][data-task-id="${CSS.escape(editing.id)}"]`);
      const title = input?.value.trim();
      if (!title || title === editing.title) { render(); return; }
      void mutate(() => requestJson(`/api/todos/${encodeURIComponent(editing.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
      }));
    }

    async function addTask(title, parentId = null) {
      const value = String(title || '').trim();
      if (!value) return;
      await mutate(() => requestJson('/api/todos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId, title: value }),
      }), parentId ? '子任务已添加' : '任务已添加');
    }

    shell.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target || !shell.contains(target)) return;
      const action = target.dataset.action;
      if (action === 'pin') {
        if (state.mode === 'pinned') { save(PINNED_KEY, '0'); setMode('peek'); scheduleClose(); }
        else setMode('pinned');
      } else if (action === 'close') setMode('hidden');
      else if (action === 'expand') {
        const id = target.dataset.taskId;
        if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
        render();
      } else if (action === 'edit') {
        const task = state.tasks.find((item) => item.id === target.dataset.taskId);
        if (!task) return;
        state.editing = { id: task.id, title: task.title }; state.expanded.add(task.parent_id || task.id); render();
      } else if (action === 'delete') {
        const task = state.tasks.find((item) => item.id === target.dataset.taskId);
        const childCount = task ? childrenFor(task.id).length : 0;
        const suffix = task?.parent_id ? '' : childCount ? `及其 ${childCount} 个子任务` : '';
        if (!task || !window.confirm(`确定删除“${task.title}”${suffix}吗？`)) return;
        void mutate(() => requestJson(`/api/todos/${encodeURIComponent(task.id)}`, { method: 'DELETE' }), '任务已删除');
      } else if (action === 'add-subtask') {
        state.addingSubtask = target.dataset.taskId; state.expanded.add(state.addingSubtask); render();
      } else if (action === 'cancel-add') {
        state.addingSubtask = null; render();
      }
    });

    shell.addEventListener('change', (event) => {
      const target = event.target;
      if (target.matches('[data-action="hover-enabled"]')) {
        state.hoverEnabled = target.checked;
        save(HOVER_KEY, target.checked ? '1' : '0');
        return;
      }
      if (target.matches('[data-action="hide-completed"]')) {
        state.hideCompleted = target.checked; save(HIDE_COMPLETED_KEY, target.checked ? '1' : '0'); render(); return;
      }
      if (!target.matches('[data-action="toggle"]')) return;
      const id = target.dataset.taskId;
      void mutate(() => requestJson(`/api/todos/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isCompleted: target.checked }),
      }));
    });

    shell.addEventListener('keydown', (event) => {
      const input = event.target;
      if (input.matches('[data-edit-input]')) {
        if (event.key === 'Enter') { event.preventDefault(); finishEdit(true); }
        if (event.key === 'Escape') { event.preventDefault(); finishEdit(false); }
      } else if (input.matches('[data-subtask-input]')) {
        if (event.key === 'Enter') { event.preventDefault(); const parentId = input.dataset.parentId; state.addingSubtask = null; void addTask(input.value, parentId); }
        if (event.key === 'Escape') { event.preventDefault(); state.addingSubtask = null; render(); }
      } else if (input === quickInput && event.key === 'Enter') {
        event.preventDefault(); const value = quickInput.value; quickInput.value = ''; void addTask(value);
      }
    });
    shell.addEventListener('focusout', (event) => {
      if (event.target.matches('[data-edit-input]')) finishEdit(true);
      if (event.target.matches('.todo-inline-input, .todo-quick-input')) state.interactionLocked = false;
    });
    shell.addEventListener('focusin', (event) => {
      if (event.target.matches('.todo-inline-input, .todo-quick-input')) state.interactionLocked = true;
    });
    quickForm.addEventListener('submit', (event) => {
      event.preventDefault(); const value = quickInput.value; quickInput.value = ''; void addTask(value);
    });
    resizeHandle.addEventListener('pointerdown', (event) => {
      if (state.mode === 'hidden') return;
      event.preventDefault();
      resizeSession = { startX: event.clientX, startWidth: state.width };
      state.interactionLocked = true;
      document.body.style.userSelect = 'none';
      resizeHandle.setPointerCapture?.(event.pointerId);
    });
    resizeHandle.addEventListener('pointermove', (event) => {
      if (!resizeSession) return;
      setWidth(resizeSession.startWidth + event.clientX - resizeSession.startX);
    });
    resizeHandle.addEventListener('pointerup', stopResize);
    resizeHandle.addEventListener('pointercancel', stopResize);
    resizeHandle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') setWidth(MIN_WIDTH, true);
      else if (event.key === 'End') setWidth(MAX_WIDTH, true);
      else setWidth(state.width + (event.key === 'ArrowRight' ? 16 : -16), true);
    });
    trigger.addEventListener('mouseenter', scheduleOpen);
    trigger.addEventListener('mouseleave', scheduleClose);
    drawer.addEventListener('mouseenter', () => { pointerInside = true; clearTimeout(closeTimer); });
    drawer.addEventListener('mouseleave', () => { pointerInside = false; scheduleClose(); });
    window.addEventListener('blur', () => { stopResize(); if (state.mode === 'peek') setMode('hidden'); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && state.mode === 'peek') setMode('hidden'); });
    document.addEventListener('keydown', (event) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'q') {
        event.preventDefault(); state.mode === 'peek' ? setMode('hidden') : setMode('peek');
      } else if (event.key === 'Escape' && state.mode === 'peek' && !state.editing && !state.addingSubtask) {
        setMode('hidden');
      }
    });

    render();
    void refresh();

    return {
      refresh,
      toggle() { state.mode === 'peek' ? setMode('hidden') : setMode('peek'); },
      setHoverEnabled(enabled) { state.hoverEnabled = enabled !== false; save(HOVER_KEY, state.hoverEnabled ? '1' : '0'); },
      setInteractionLocked(locked) { state.interactionLocked = Boolean(locked); },
      getState() { return { ...state, tasks: state.tasks.map((task) => ({ ...task })) }; },
    };
  }

  root.AgentBoardProjectTodo = { createProjectTodoDrawer };
})(window);
