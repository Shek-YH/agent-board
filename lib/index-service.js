'use strict';

const crypto = require('node:crypto');

const MAX_CATEGORY_LENGTH = 50;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 100000;
const MAX_ENTRIES = 2000;

function createIndexService({ repository, now = () => Date.now(), createId = () => crypto.randomUUID() } = {}) {
  if (!repository || typeof repository.listEntries !== 'function') {
    throw new TypeError('Index repository must provide listEntries()');
  }

  const clone = (x) => (x ? { ...x } : null);
  const ts = () => new Date(now()).toISOString();

  function trimText(value, max, field) {
    const s = String(value == null ? '' : value).trim();
    if (!s) throw new Error(`${field}不能为空`);
    if (s.length > max) throw new Error(`${field}长度不能超过 ${max} 个字符`);
    return s;
  }

  function entryById(id) { return repository.getEntry(String(id)); }

  function nextSortOrder(category) {
    const same = repository.listEntries().filter((e) => (e.category || '') === (category || ''));
    return same.reduce((max, e) => Math.max(max, Number(e.order) || 0), 0) + 1;
  }

  function ensureCategoryOrder(category) {
    const order = repository.getCategoryOrder();
    if (!Array.isArray(order)) return;
    const cat = String(category || '').trim();
    if (!cat || order.includes(cat)) return;
    order.push(cat);
    repository.setCategoryOrder(order);
  }

  function createEntry({ category, title, content, source = 'manual', sourcePath = '' } = {}) {
    if (repository.listEntries().length >= MAX_ENTRIES) throw new Error(`索引条目已达上限 ${MAX_ENTRIES}`);
    const cat = trimText(category, MAX_CATEGORY_LENGTH, '分类');
    const createdAt = ts();
    const entry = {
      id: `idx_${createId().replace(/-/g, '').slice(0, 12)}`,
      category: cat,
      title: trimText(title, MAX_TITLE_LENGTH, '标题'),
      content: String(content == null ? '' : content),
      source: source === 'obsidian' ? 'obsidian' : 'manual',
      sourcePath: String(sourcePath || ''),
      createdAt,
      updatedAt: createdAt,
      order: nextSortOrder(cat),
    };
    repository.insertEntry(entry);
    ensureCategoryOrder(cat);
    return clone(entry);
  }

  function updateEntry(id, changes = {}) {
    const entry = entryById(id);
    if (!entry) throw new Error('索引条目不存在');
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(changes, 'title')) patch.title = trimText(changes.title, MAX_TITLE_LENGTH, '标题');
    if (Object.prototype.hasOwnProperty.call(changes, 'content')) {
      const c = String(changes.content == null ? '' : changes.content);
      if (c.length > MAX_CONTENT_LENGTH) throw new Error(`内容长度不能超过 ${MAX_CONTENT_LENGTH} 个字符`);
      patch.content = c;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'category')) {
      const newCat = trimText(changes.category, MAX_CATEGORY_LENGTH, '分类');
      if (newCat !== entry.category) {
        patch.category = newCat;
        patch.order = nextSortOrder(newCat);
      }
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'order')) patch.order = Number(changes.order) || entry.order;
    if (Object.prototype.hasOwnProperty.call(changes, 'sourcePath')) patch.sourcePath = String(changes.sourcePath || '');
    if (!Object.keys(patch).length) return clone(entry);
    patch.updatedAt = ts();
    repository.updateEntry(entry.id, patch);
    if (patch.category) ensureCategoryOrder(patch.category);
    return clone(entryById(entry.id));
  }

  function deleteEntry(id) {
    const entry = entryById(id);
    if (!entry) throw new Error('索引条目不存在');
    repository.deleteEntry(entry.id);
    return true;
  }

  function reorderEntries(orderedIds) {
    if (!Array.isArray(orderedIds)) throw new Error('orderedIds 必须是数组');
    const now = ts();
    for (let i = 0; i < orderedIds.length; i++) {
      const id = String(orderedIds[i]);
      const entry = entryById(id);
      if (!entry) continue;
      repository.updateEntry(id, { order: (i + 1) * 10, updatedAt: now });
    }
    return true;
  }

  function setCategoryOrder(order) {
    if (!Array.isArray(order)) throw new Error('categoryOrder 必须是数组');
    const valid = order.map((c) => String(c || '').trim()).filter(Boolean);
    repository.setCategoryOrder(valid);
    return valid;
  }

  function getEntries() {
    return repository.listEntries()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(clone);
  }

  function getCategoryOrder() {
    const order = repository.getCategoryOrder();
    if (Array.isArray(order)) return [...order];
    const cats = [...new Set(getEntries().map((e) => e.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
    repository.setCategoryOrder(cats);
    return cats;
  }

  return {
    createEntry, updateEntry, deleteEntry, reorderEntries,
    setCategoryOrder, getEntries, getCategoryOrder,
    constants: { MAX_CATEGORY_LENGTH, MAX_TITLE_LENGTH, MAX_CONTENT_LENGTH, MAX_ENTRIES },
  };
}

module.exports = { createIndexService, MAX_CATEGORY_LENGTH, MAX_TITLE_LENGTH, MAX_CONTENT_LENGTH, MAX_ENTRIES };