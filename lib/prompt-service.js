'use strict';

const crypto = require('node:crypto');

const MAX_GROUP_NAME_LENGTH = 50;
const MAX_PROMPT_TITLE_LENGTH = 100;
const MAX_PROMPT_CONTENT_LENGTH = 10000;
const MAX_GROUPS = 50;
const MAX_PROMPTS_PER_GROUP = 200;

function createPromptService({ repository, now = () => Date.now(), createId = () => crypto.randomUUID() } = {}) {
  if (!repository || typeof repository.listGroups !== 'function' || typeof repository.listPrompts !== 'function') {
    throw new TypeError('Prompt repository must provide listGroups() and listPrompts()');
  }

  const clone = (x) => (x ? { ...x } : null);
  const ts = () => new Date(now()).toISOString();

  function trimText(value, max, field) {
    const s = String(value == null ? '' : value).trim();
    if (!s) throw new Error(`${field}不能为空`);
    if (s.length > max) throw new Error(`${field}长度不能超过 ${max} 个字符`);
    return s;
  }

  function groupById(id) { return repository.getGroup(String(id)); }
  function promptById(id) { return repository.getPrompt(String(id)); }

  function nextGroupSortOrder() {
    const groups = repository.listGroups();
    return groups.reduce((max, g) => Math.max(max, Number(g.sort_order) || 0), 0) + 1;
  }

  function nextPromptSortOrder(groupId) {
    const prompts = repository.listPrompts().filter((p) => p.group_id === groupId);
    return prompts.reduce((max, p) => Math.max(max, Number(p.sort_order) || 0), 0) + 1;
  }

  function createGroup({ name } = {}) {
    if (repository.listGroups().length >= MAX_GROUPS) throw new Error(`分组数已达上限 ${MAX_GROUPS}`);
    const createdAt = ts();
    const group = {
      id: String(createId()),
      name: trimText(name, MAX_GROUP_NAME_LENGTH, '分组名'),
      sort_order: nextGroupSortOrder(),
      collapsed: false,
      created_at: createdAt,
      updated_at: createdAt,
    };
    repository.insertGroup(group);
    return clone(group);
  }

  function updateGroup(id, changes = {}) {
    const group = groupById(id);
    if (!group) throw new Error('分组不存在');
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(changes, 'name')) patch.name = trimText(changes.name, MAX_GROUP_NAME_LENGTH, '分组名');
    if (Object.prototype.hasOwnProperty.call(changes, 'collapsed')) patch.collapsed = Boolean(changes.collapsed);
    if (Object.prototype.hasOwnProperty.call(changes, 'sort_order')) patch.sort_order = Number(changes.sort_order) || group.sort_order;
    if (!Object.keys(patch).length) return clone(group);
    patch.updated_at = ts();
    repository.updateGroup(group.id, patch);
    return clone(groupById(group.id));
  }

  function deleteGroup(id) {
    const group = groupById(id);
    if (!group) throw new Error('分组不存在');
    const prompts = repository.listPrompts().filter((p) => p.group_id === group.id);
    for (const p of prompts) repository.deletePrompt(p.id);
    repository.deleteGroup(group.id);
    return { deletedPrompts: prompts.length };
  }

  function createPrompt({ group_id, title, content } = {}) {
    if (!group_id) throw new Error('必须选择分组');
    const group = groupById(group_id);
    if (!group) throw new Error('分组不存在');
    const promptsInGroup = repository.listPrompts().filter((p) => p.group_id === group.id);
    if (promptsInGroup.length >= MAX_PROMPTS_PER_GROUP) throw new Error(`该分组提示词已达上限 ${MAX_PROMPTS_PER_GROUP}`);
    const createdAt = ts();
    const prompt = {
      id: String(createId()),
      group_id: group.id,
      title: trimText(title, MAX_PROMPT_TITLE_LENGTH, '标题'),
      content: String(content == null ? '' : content),
      sort_order: nextPromptSortOrder(group.id),
      use_count: 0,
      last_used_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    repository.insertPrompt(prompt);
    return clone(prompt);
  }

  function updatePrompt(id, changes = {}) {
    const prompt = promptById(id);
    if (!prompt) throw new Error('提示词不存在');
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(changes, 'title')) patch.title = trimText(changes.title, MAX_PROMPT_TITLE_LENGTH, '标题');
    if (Object.prototype.hasOwnProperty.call(changes, 'content')) {
      const c = String(changes.content == null ? '' : changes.content);
      if (c.length > MAX_PROMPT_CONTENT_LENGTH) throw new Error(`内容长度不能超过 ${MAX_PROMPT_CONTENT_LENGTH} 个字符`);
      patch.content = c;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'group_id')) {
      const targetGroup = groupById(changes.group_id);
      if (!targetGroup) throw new Error('目标分组不存在');
      patch.group_id = targetGroup.id;
      // 只有分组真正变化时才重排到目标组末尾（sort_order = max+1）。
      // 分组未变时保持原排序：否则仅编辑标题/内容也会把提示词挪到末尾，
      // 而提示词没有上/下移 UI，该顺序不可逆。
      if (targetGroup.id !== prompt.group_id) patch.sort_order = nextPromptSortOrder(targetGroup.id);
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'sort_order')) patch.sort_order = Number(changes.sort_order) || prompt.sort_order;
    if (!Object.keys(patch).length) return clone(prompt);
    patch.updated_at = ts();
    repository.updatePrompt(prompt.id, patch);
    return clone(promptById(prompt.id));
  }

  function deletePrompt(id) {
    const prompt = promptById(id);
    if (!prompt) throw new Error('提示词不存在');
    repository.deletePrompt(prompt.id);
    return true;
  }

  function recordUse(id) {
    const prompt = promptById(id);
    if (!prompt) throw new Error('提示词不存在');
    repository.updatePrompt(prompt.id, {
      use_count: (Number(prompt.use_count) || 0) + 1,
      last_used_at: ts(),
      updated_at: ts(),
    });
    return clone(promptById(prompt.id));
  }

  function getGroups() {
    return repository.listGroups()
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.created_at).localeCompare(String(b.created_at)))
      .map(clone);
  }

  function getPrompts() {
    return repository.listPrompts()
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.created_at).localeCompare(String(b.created_at)))
      .map(clone);
  }

  return {
    createGroup, updateGroup, deleteGroup, getGroups,
    createPrompt, updatePrompt, deletePrompt, recordUse, getPrompts,
    constants: {
      MAX_GROUP_NAME_LENGTH, MAX_PROMPT_TITLE_LENGTH, MAX_PROMPT_CONTENT_LENGTH,
      MAX_GROUPS, MAX_PROMPTS_PER_GROUP,
    },
  };
}

module.exports = { createPromptService, MAX_GROUP_NAME_LENGTH, MAX_PROMPT_TITLE_LENGTH, MAX_PROMPT_CONTENT_LENGTH, MAX_GROUPS, MAX_PROMPTS_PER_GROUP };