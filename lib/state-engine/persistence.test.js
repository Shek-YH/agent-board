'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createInitialRuntime, cloneRuntime } = require('./runtime');
const { createStateEnginePersistence } = require('./persistence');

function runtime() {
  return cloneRuntime(createInitialRuntime({
    sessionRef: 'codex:persisted',
    identity: { agent: 'codex', hostId: 'host-1', nativeSessionId: 'native-1', generation: 3 },
  }), {
    turnState: 'COMPLETED',
    sessionLifecycle: 'OPEN',
    completionNotificationIds: ['completion-1'],
    recentEvidence: [{ evidenceId: 'raw-1', value: { command: 'private transcript-like value' } }],
  });
}

test('persistence saves a versioned safe snapshot without raw recent evidence values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-state-persistence-'));
  const filePath = path.join(dir, 'state-engine.json');
  try {
    const persistence = createStateEnginePersistence({ filePath });
    persistence.save({ sessions: [{ runtime: runtime(), watermark: { sources: { 'codex:codex:persisted:jsonl': { generation: 3, lastSequence: 8, lastOffset: 90, lastObservedAt: 200 } }, acceptedEvidenceIds: ['raw-1'] } }] });
    const raw = fs.readFileSync(filePath, 'utf8');
    const loaded = persistence.load();

    assert.equal(JSON.parse(raw).schemaVersion, 1);
    assert.equal(raw.includes('private transcript-like value'), false);
    assert.equal(raw.includes('recentEvidence'), false);
    assert.equal(loaded.sessions[0].runtime.identity.generation, 3);
    assert.deepEqual(loaded.sessions[0].runtime.completionNotificationIds, ['completion-1']);
    assert.equal(loaded.sessions[0].watermark.sources['codex:codex:persisted:jsonl'].lastSequence, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('persistence rejects a corrupt snapshot without overwriting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-state-persistence-corrupt-'));
  const filePath = path.join(dir, 'state-engine.json');
  try {
    fs.writeFileSync(filePath, '{not-json', 'utf8');
    const persistence = createStateEnginePersistence({ filePath });
    assert.equal(persistence.load(), null);
    assert.equal(fs.readFileSync(filePath, 'utf8'), '{not-json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
