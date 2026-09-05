'use strict';

const crypto = require('node:crypto');

const MAX_TITLE_LENGTH = 500;
const MAX_DEPTH = 1;

function createTodoService({ repository, now = () => Date.now(), createId = () => crypto.randomUUID() } = {}) {
  if (!repository || typeof repository.list !== 'function') {
    throw new TypeError('Todo repository must provide list()');
  }

  const clone = (task) => task ? { ...task } : null;
  const taskById = (id) => repository.get(String(id));
  const timestamp = () => new Date(now()).toISOString();

  function titleValue(title) {
    const value = String(title == null ? '' : title).trim();
    if (!value || value.length > MAX_TITLE_LENGTH) throw new Error('任务标题长度必须为 1 到 500 个字符');
    return value;
  }

  function childrenOf(parentId) {
    return repository.list().filter((task) => task.parent_id === parentId);
  }

  function siblingSortOrder(parentId) {
    const siblings = repository.list().filter((task) => (task.parent_id || null) === (parentId || null));
    return siblings.reduce((max, task) => Math.max(max, Number(task.sort_order) || 0), 0) + 1;
  }

  function assertParent(parentId) {
    if (parentId == null || parentId === '') return null;
    const parent = taskById(parentId);
    if (!parent) throw new Error('父任务不存在');
    if (parent.parent_id != null) throw new Error('V1 只支持一级子任务');
    return parent;
  }

  function createTask({ parentId = null, title } = {}) {
    const parent = assertParent(parentId);
    const createdAt = timestamp();
    const task = {
      id: String(createId()),
      project_id: null,
      parent_id: parent ? parent.id : null,
      title: titleValue(title),
      is_completed: false,
      completed_at: null,
      sort_order: siblingSortOrder(parent ? parent.id : null),
      created_at: createdAt,
      updated_at: createdAt,
    };
    repository.insert(task);
    if (parent && parent.is_completed) {
      repository.update(parent.id, { is_completed: false, completed_at: null, updated_at: timestamp() });
    }
    return clone(task);
  }

  function updateTask(id, changes = {}) {
    const task = taskById(id);
    if (!task) throw new Error('任务不存在');
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(changes, 'title')) patch.title = titleValue(changes.title);
    if (!Object.keys(patch).length) return clone(task);
    patch.updated_at = timestamp();
    repository.update(task.id, patch);
    return clone(taskById(task.id));
  }

  function setTaskCompleted(id, completed) {
    const task = taskById(id);
    if (!task) throw new Error('任务不存在');
    const next = Boolean(completed);
    const completedAt = next ? timestamp() : null;
    repository.update(task.id, { is_completed: next, completed_at: completedAt, updated_at: timestamp() });
    if (task.parent_id == null) {
      for (const child of childrenOf(task.id)) {
        repository.update(child.id, { is_completed: next, completed_at: completedAt, updated_at: timestamp() });
      }
    } else {
      const parent = taskById(task.parent_id);
      const children = childrenOf(task.parent_id);
      if (parent && children.length && children.every((child) => child.is_completed)) {
        repository.update(parent.id, { is_completed: true, completed_at: timestamp(), updated_at: timestamp() });
      } else if (parent) {
        repository.update(parent.id, { is_completed: false, completed_at: null, updated_at: timestamp() });
      }
    }
    return clone(taskById(task.id));
  }

  function deleteTask(id) {
    const task = taskById(id);
    if (!task) throw new Error('任务不存在');
    for (const child of childrenOf(task.id)) repository.delete(child.id);
    repository.delete(task.id);
    return true;
  }

  function getTasks() {
    return repository.list()
      .sort((a, b) => {
        const parentOrder = (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0);
        if (parentOrder) return parentOrder;
        return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.created_at).localeCompare(String(b.created_at));
      })
      .map(clone);
  }

  return {
    createTask,
    updateTask,
    setTaskCompleted,
    deleteTask,
    getTasks,
    getProjectTasks: getTasks,
    getTask: (id) => clone(taskById(id)),
    constants: { MAX_TITLE_LENGTH, MAX_DEPTH },
  };
}

module.exports = { createTodoService, MAX_TITLE_LENGTH, MAX_DEPTH };
