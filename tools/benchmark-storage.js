'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const filePath = path.join(os.tmpdir(), `agent-board-storage-benchmark-${process.pid}.json`);
const snapshot = {
  sessions: Array.from({ length: 10000 }, (_, index) => ({ id: `s-${index}`, last_seen: index })),
  messages: Array.from({ length: 20000 }, (_, index) => ({ id: `m-${index}`, session_ref: `codex:s-${index % 10000}` })),
};

try {
  const encoded = JSON.stringify(snapshot);
  fs.writeFileSync(filePath, encoded, 'utf8');
  const before = process.memoryUsage().rss;
  const start = process.hrtime.bigint();
  const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const parsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const stringifyStart = process.hrtime.bigint();
  const rewritten = JSON.stringify(loaded);
  const stringifyMs = Number(process.hrtime.bigint() - stringifyStart) / 1e6;
  console.log(JSON.stringify({
    fileBytes: Buffer.byteLength(encoded),
    sessions: loaded.sessions.length,
    messages: loaded.messages.length,
    parseMs: Number(parsedMs.toFixed(2)),
    stringifyMs: Number(stringifyMs.toFixed(2)),
    rssDeltaBytes: process.memoryUsage().rss - before,
    note: 'Synthetic JSON baseline only; no user data or alternate backend was used.',
  }, null, 2));
} finally {
  fs.rmSync(filePath, { force: true });
}
