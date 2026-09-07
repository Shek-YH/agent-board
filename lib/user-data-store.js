'use strict';
// 用户创作数据（待办 / 提示词 / 索引）的独立持久化存储。
//
// 为什么独立成文件：这三类数据是用户手写的资产，而 data.json 是 100MB+ 的会话缓存，
// 两者共用同一文件时任何一次写失败 / 文件损坏 / 空快照覆盖 / 全量清库都会把用户资产一起带走。
// 独立后：文件小（几 KB~几 MB）、原子写、写前 .bak 备份、损坏自动回退、多实例按 id 合并，
// 且 clearAll / rescan / 会话重置天然不再影响它们。
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'user-data.json';
const BAK_SUFFIX = '.bak';
const TMP_SUFFIX = '.tmp';
const VERSION = 1;

// 顺序即导出顺序；索引分类顺序单独字段维护
const COLLECTION_KEYS = ['todoTasks', 'promptGroups', 'prompts', 'indexEntries'];

// 历史命名不统一：待办/提示词用 snake_case(updated_at)，索引用 camelCase(updatedAt)
function updatedAtOf(item) {
  if (!item || typeof item !== 'object') return 0;
  const raw = item.updated_at != null ? item.updated_at : item.updatedAt;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  const created = item.created_at != null ? item.created_at : item.createdAt;
  const parsedCreated = Date.parse(created);
  return Number.isFinite(parsedCreated) ? parsedCreated : 0;
}

function emptySnapshot() {
  return {
    version: VERSION,
    todoTasks: [],
    promptGroups: [],
    prompts: [],
    indexEntries: [],
    indexCategoryOrder: [],
  };
}

function countAll(snapshot) {
  if (!snapshot) return 0;
  return COLLECTION_KEYS.reduce((sum, key) => sum + (Array.isArray(snapshot[key]) ? snapshot[key].length : 0), 0);
}

function isUsableSnapshot(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data)
    && COLLECTION_KEYS.some((key) => Array.isArray(data[key]));
}

// 补齐字段、丢掉无 id 的脏数据，保证落盘结构稳定
function normalizeSnapshot(raw) {
  const out = emptySnapshot();
  if (!raw || typeof raw !== 'object') return out;
  // 保留写入时间戳：合并时用它判断「内存有而磁盘无」到底是新建还是被别处删除
  if (typeof raw.savedAt === 'string') out.savedAt = raw.savedAt;
  if (raw.version != null) out.version = Number(raw.version) || VERSION;
  for (const key of COLLECTION_KEYS) {
    const list = Array.isArray(raw[key]) ? raw[key] : [];
    const seen = new Set();
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (item.id == null || String(item.id) === '') continue;
      const id = String(item.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out[key].push({ ...item, id });
    }
  }
  const order = Array.isArray(raw.indexCategoryOrder) ? raw.indexCategoryOrder : [];
  const seenCat = new Set();
  for (const cat of order) {
    const value = String(cat == null ? '' : cat).trim();
    if (!value || seenCat.has(value)) continue;
    seenCat.add(value);
    out.indexCategoryOrder.push(value);
  }
  return out;
}

// 合并两份快照（base=磁盘，incoming=本实例内存）。
//
// 不能简单取并集：那样「删除」永远无法生效——A 删掉一条，B 用旧内存合并时又把它加回来。
// 因此用时间戳判断差异方向（diskSavedAt = 磁盘最后一次写入时刻，loadedAt = 本实例最后一次读取时刻）：
//   · 内存有、磁盘无 → 若该条目新于 diskSavedAt，说明是本实例新建的，保留；否则说明是被别处删掉的，丢弃
//   · 磁盘有、内存无 → 若该条目新于 loadedAt，说明是别的实例新建的，保留；否则说明是本实例删掉的，丢弃
//   · 两边都有       → 取 updated 较新的一份
function mergeSnapshots(base, incoming, { loadedAt = 0 } = {}) {
  const a = normalizeSnapshot(base);
  const b = normalizeSnapshot(incoming);
  const diskSavedAt = Number.isFinite(Date.parse(a.savedAt)) ? Date.parse(a.savedAt) : 0;
  const sinceLoad = Number.isFinite(Number(loadedAt)) ? Number(loadedAt) : 0;
  const out = emptySnapshot();
  for (const key of COLLECTION_KEYS) {
    const map = new Map();
    const diskIds = new Set(a[key].map((item) => String(item.id)));
    for (const item of b[key]) {
      const id = String(item.id);
      const diskItem = a[key].find((x) => String(x.id) === id);
      if (diskItem) {
        // 两边都有：取更新时间较新的一份
        if (updatedAtOf(item) >= updatedAtOf(diskItem)) map.set(id, item);
        else map.set(id, diskItem);
        continue;
      }
      // 内存有、磁盘无：只有「比磁盘最后一次写入还新」才算本实例新建
      const itemTime = updatedAtOf(item);
      if (itemTime > diskSavedAt) map.set(id, item);
    }
    for (const item of a[key]) {
      const id = String(item.id);
      if (map.has(id) || diskIds.has(id) === false) continue;
      // 磁盘有、内存无：只有「比本实例最后一次读取还新」才算别处新建
      if (updatedAtOf(item) > sinceLoad) map.set(id, item);
    }
    out[key] = [...map.values()];
  }
  const seen = new Set();
  for (const cat of [...b.indexCategoryOrder, ...a.indexCategoryOrder]) {
    const value = String(cat == null ? '' : cat).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.indexCategoryOrder.push(value);
  }
  return out;
}

function createUserDataStore({ dir, now = () => Date.now(), logError = () => {} } = {}) {
  if (!dir) throw new TypeError('user data store 需要 dir');
  const filePath = path.join(dir, FILE_NAME);
  const bakPath = filePath + BAK_SUFFIX;

  function readFileSafe(target) {
    try {
      if (!fs.existsSync(target)) return null;
      const text = fs.readFileSync(target, 'utf-8');
      if (!text.trim()) return null;
      const parsed = JSON.parse(text);
      return isUsableSnapshot(parsed) ? normalizeSnapshot(parsed) : null;
    } catch (error) {
      logError('read', error, target);
      return null;
    }
  }

  // 同步加载：主文件 → 损坏则回退 .bak → 都没有则空快照
  function load() {
    const main = readFileSafe(filePath);
    if (main) return { data: main, source: 'main' };
    const bak = readFileSafe(bakPath);
    if (bak) {
      // 主文件坏了但备份完好：立刻把备份写回主文件，避免继续在坏文件上叠加写入
      try {
        fs.writeFileSync(filePath, JSON.stringify(bak, null, 2), 'utf-8');
      } catch (error) { logError('restore', error, filePath); }
      return { data: bak, source: 'bak' };
    }
    return { data: emptySnapshot(), source: 'none' };
  }

  async function writeAtomic(snapshot) {
    const json = JSON.stringify(snapshot, null, 2);
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.copyFile(filePath, bakPath);
      }
    } catch (error) {
      logError('backup', error, bakPath);
    }
    const tmp = `${filePath}.${process.pid}${TMP_SUFFIX}`;
    try {
      await fs.promises.writeFile(tmp, json, 'utf-8');
      await fs.promises.rename(tmp, filePath);
    } catch (error) {
      logError('rename', error, tmp);
      // rename 失败（安全软件短暂加锁）→ 回退原地覆写，写入本身通常不受锁影响
      await fs.promises.writeFile(filePath, json, 'utf-8');
      try { if (fs.existsSync(tmp)) await fs.promises.unlink(tmp); } catch { /* ignore */ }
    }
  }

  // 同步保存：进程退出前（beforeExit/SIGINT）使用——异步 fs 在退出阶段可能来不及落盘
  function saveSync(incoming, { replace = false, loadedAt = 0 } = {}) {
    const next = normalizeSnapshot(incoming);
    const disk = replace ? null : readFileSafe(filePath);
    const merged = replace ? next : mergeSnapshots(disk, next, { loadedAt });
    if (!replace && countAll(merged) === 0 && countAll(disk) > 0) {
      logError('guard', new Error('拒绝空快照覆盖用户数据（同步）'), filePath);
      return disk;
    }
    merged.version = VERSION;
    merged.savedAt = new Date(now()).toISOString();
    const json = JSON.stringify(merged, null, 2);
    try {
      if (fs.existsSync(filePath)) fs.copyFileSync(filePath, bakPath);
    } catch (error) { logError('backup', error, bakPath); }
    const tmp = `${filePath}.${process.pid}${TMP_SUFFIX}`;
    try {
      fs.writeFileSync(tmp, json, 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      logError('rename', error, tmp);
      fs.writeFileSync(filePath, json, 'utf-8');
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    return merged;
  }

  // 保存：默认与磁盘现有内容合并（多实例安全）；replace=true 时整体覆盖（导入用）
  async function save(incoming, { replace = false, loadedAt = 0 } = {}) {
    const next = normalizeSnapshot(incoming);
    const disk = replace ? null : readFileSafe(filePath);
    const merged = replace ? next : mergeSnapshots(disk, next, { loadedAt });
    // 防空覆盖：内存全空而磁盘有数据时，绝不用空快照覆盖
    if (!replace && countAll(merged) === 0 && countAll(disk) > 0) {
      logError('guard', new Error('拒绝空快照覆盖用户数据'), filePath);
      return disk;
    }
    merged.version = VERSION;
    merged.savedAt = new Date(now()).toISOString();
    await writeAtomic(merged);
    return merged;
  }

  return { filePath, bakPath, load, save, saveSync, readFileSafe };
}

module.exports = {
  FILE_NAME,
  BAK_SUFFIX,
  VERSION,
  COLLECTION_KEYS,
  createUserDataStore,
  emptySnapshot,
  normalizeSnapshot,
  mergeSnapshots,
  updatedAtOf,
  countAll,
  isUsableSnapshot,
};
