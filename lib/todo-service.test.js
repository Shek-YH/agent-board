'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTodoService } = require('./todo-service');

function makeService() {
  const tasks = new Map();
  let id = 0;
  let clock = 0;
  const repository = {
    list: () => [...tasks.values()],
    get: (taskId) => tasks.get(String(taskId)),
    insert: (task) => tasks.set(task.id, { ...task }),
    update: (taskId, patch) => tasks.set(String(taskId), { ...tasks.get(String(taskId)), ...patch }),
    delete: (taskId) => tasks.delete(String(taskId)),
  };
  return {
    service: createTodoService({
      repository,
      now: () => ++clock,
      createId: () => `task-${++id}`,
    }),
    tasks,
  };
}

test('creates global top-level and one-level child tasks', () => {
  const { service } = makeService();
  const parent = service.createTask({ title: 'Parent' });
  const child = service.createTask({ parentId: parent.id, title: 'Child' });

  assert.equal(parent.project_id, null);
  assert.equal(parent.parent_id, null);
  assert.equal(child.parent_id, parent.id);
  assert.throws(() => service.createTask({ parentId: child.id, title: 'Too deep' }), /一级/);
});

test('completing a parent cascades to children and unchecking it reverses the cascade', () => {
  const { service, tasks } = makeService();
  const parent = service.createTask({ title: 'Parent' });
  const first = service.createTask({ parentId: parent.id, title: 'First' });
  const second = service.createTask({ parentId: parent.id, title: 'Second' });

  service.setTaskCompleted(parent.id, true);
  assert.equal(tasks.get(parent.id).is_completed, true);
  assert.equal(tasks.get(first.id).is_completed, true);
  assert.equal(tasks.get(second.id).is_completed, true);

  service.setTaskCompleted(parent.id, false);
  assert.equal(tasks.get(parent.id).is_completed, false);
  assert.equal(tasks.get(first.id).is_completed, false);
  assert.equal(tasks.get(second.id).is_completed, false);
});

test('child completion auto-completes the parent and partial completion leaves parent indeterminate', () => {
  const { service, tasks } = makeService();
  const parent = service.createTask({ title: 'Parent' });
  const first = service.createTask({ parentId: parent.id, title: 'First' });
  const second = service.createTask({ parentId: parent.id, title: 'Second' });

  service.setTaskCompleted(first.id, true);
  assert.equal(tasks.get(parent.id).is_completed, false);
  service.setTaskCompleted(second.id, true);
  assert.equal(tasks.get(parent.id).is_completed, true);
  service.setTaskCompleted(second.id, false);
  assert.equal(tasks.get(parent.id).is_completed, false);
  assert.equal(tasks.get(parent.id).completed_at, null);
});

test('adding an incomplete child reopens a completed parent', () => {
  const { service, tasks } = makeService();
  const parent = service.createTask({ title: 'Parent' });
  service.setTaskCompleted(parent.id, true);

  service.createTask({ parentId: parent.id, title: 'New child' });

  assert.equal(tasks.get(parent.id).is_completed, false);
  assert.equal(tasks.get(parent.id).completed_at, null);
});

test('deleting a parent deletes its children', () => {
  const { service, tasks } = makeService();
  const parent = service.createTask({ title: 'Parent' });
  const child = service.createTask({ parentId: parent.id, title: 'Child' });

  service.deleteTask(parent.id);
  assert.equal(tasks.has(parent.id), false);
  assert.equal(tasks.has(child.id), false);
});
