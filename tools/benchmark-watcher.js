'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tailRead, tailRecent } = require('../lib/watcher');

const file = path.join(os.tmpdir(), `agent-board-watcher-${process.pid}.jsonl`);
const targetBytes = 100 * 1024 * 1024;
const line = `${JSON.stringify({ n: 0, text: 'x'.repeat(220) })}\n`;
const block = Buffer.from(line.repeat(Math.max(1, Math.floor((1024 * 1024) / line.length))), 'utf8');

function legacyTailRead(filePath, offset, maxBytes) {
  const buffer = fs.readFileSync(filePath);
  const chunk = buffer.subarray(offset, Math.min(offset + maxBytes, buffer.length)).toString('utf8');
  const nl = chunk.lastIndexOf('\n');
  if (nl === -1) return { lines: [], newOffset: offset };
  const lines = [];
  for (const raw of chunk.slice(0, nl).split('\n')) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); } catch { /* partial leading line */ }
  }
  return { lines, newOffset: offset + Buffer.byteLength(chunk.slice(0, nl), 'utf8') + 1 };
}

function measure(label, fn) {
  global.gc?.();
  const before = process.memoryUsage().rss;
  const start = process.hrtime.bigint();
  const result = fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return {
    label,
    lines: result.lines.length,
    newOffset: result.newOffset,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    rssDeltaBytes: process.memoryUsage().rss - before,
  };
}

try {
  const fd = fs.openSync(file, 'w');
  let written = 0;
  while (written < targetBytes) {
    const bytes = block.length;
    fs.writeSync(fd, block, 0, bytes, written);
    written += bytes;
  }
  fs.closeSync(fd);

  const offset = written - 8 * 1024 * 1024;
  const legacy = measure('legacy-whole-file', () => legacyTailRead(file, offset, 8 * 1024 * 1024));
  const ranged = measure('bounded-range', () => tailRead(file, offset, 8 * 1024 * 1024));
  const recent = tailRecent(file, 512 * 1024);
  console.log(JSON.stringify({
    fileBytes: written,
    runs: [legacy, ranged],
    recentLines: recent.lines.length,
    requestedTailBytes: 8 * 1024 * 1024,
    requestedRecentBytes: 512 * 1024,
  }, null, 2));
} finally {
  fs.rmSync(file, { force: true });
}
