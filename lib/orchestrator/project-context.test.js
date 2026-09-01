'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateProjectContext } = require('./project-context');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-project-context-'));
}

test('project context rejects a missing or non-directory path', () => {
  const root = tempRoot();
  assert.throws(() => validateProjectContext({ projectPath: path.join(root, 'missing'), allowedRoots: [root] }), (error) => {
    assert.equal(error.code, 'PROJECT_NOT_FOUND');
    return true;
  });
  const file = path.join(root, 'file.txt');
  fs.writeFileSync(file, 'safe');
  assert.throws(() => validateProjectContext({ projectPath: file, allowedRoots: [root] }), (error) => {
    assert.equal(error.code, 'PROJECT_NOT_DIRECTORY');
    return true;
  });
});

test('project context reports readable/writable Git state without reading secret contents', () => {
  const root = tempRoot();
  const project = path.join(root, 'app');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, '.env'), 'DO_NOT_READ=secret');
  const result = validateProjectContext({
    projectPath: project,
    allowedRoots: [root],
    runCommand: (command, args) => {
      assert.equal(command, 'git');
      if (args.includes('--show-toplevel')) return { code: 0, stdout: project, stderr: '' };
      if (args.includes('--abbrev-ref')) return { code: 0, stdout: 'main', stderr: '' };
      if (args.includes('--porcelain')) return { code: 0, stdout: ' M src/app.js', stderr: '' };
      throw new Error('unexpected git probe');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.readable, true);
  assert.equal(result.writable, true);
  assert.deepEqual(result.git, { isGit: true, root: path.resolve(project), branch: 'main', dirty: true });
  assert.deepEqual(result.secretFiles, ['.env']);
  assert.match(result.warnings.join('\n'), /敏感文件/);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_READ=secret/);
});

test('project context accepts non-Git folders with an explicit warning and blocks outside roots', () => {
  const root = tempRoot();
  const project = path.join(root, 'plain');
  fs.mkdirSync(project);
  const result = validateProjectContext({
    projectPath: project,
    allowedRoots: [root],
    runCommand: () => ({ code: 1, stdout: '', stderr: 'not a git repository' }),
  });
  assert.equal(result.git.isGit, false);
  assert.match(result.warnings.join('\n'), /Git/);

  const outside = tempRoot();
  assert.throws(() => validateProjectContext({ projectPath: outside, allowedRoots: [root] }), (error) => {
    assert.equal(error.code, 'PROJECT_OUTSIDE_ALLOWED_ROOTS');
    return true;
  });
});
