'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { classifyProject } = require('./project-classifier');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-classifier-'));
}

test('missing path is classified as a new project without creating it', () => {
  const root = tempDir();
  const target = path.join(root, 'new-project');
  const result = classifyProject(target);
  assert.equal(result.kind, 'new');
  assert.equal(result.exists, false);
  assert.equal(fs.existsSync(target), false);
});

test('blank path is invalid and never resolves to the current working directory', () => {
  assert.equal(classifyProject('').kind, 'invalid');
  assert.equal(classifyProject('   ').kind, 'invalid');
});

test('empty directory is classified as a new project', () => {
  const target = tempDir();
  const result = classifyProject(target);
  assert.equal(result.kind, 'new');
  assert.equal(result.exists, true);
  assert.equal(result.hasGit, false);
});

test('git directory is classified as an existing project', () => {
  const target = tempDir();
  fs.mkdirSync(path.join(target, '.git'));
  const result = classifyProject(target);
  assert.equal(result.kind, 'existing');
  assert.equal(result.hasGit, true);
});

test('manifest without git is classified as an existing unversioned project', () => {
  const target = tempDir();
  fs.writeFileSync(path.join(target, 'package.json'), '{}');
  const result = classifyProject(target);
  assert.equal(result.kind, 'existing_unversioned');
  assert.deepEqual(result.manifests, ['package.json']);
});

test('file path is invalid and does not get modified', () => {
  const root = tempDir();
  const target = path.join(root, 'file.txt');
  fs.writeFileSync(target, 'keep');
  const result = classifyProject(target);
  assert.equal(result.kind, 'invalid');
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});
