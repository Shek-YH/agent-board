'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const start = source.indexOf('function shortProj');
const end = source.indexOf('function topologyRoleMarkup');
const shortProj = new Function(source.slice(start, end) + '; return shortProj;')();

test('session project label shows only the final directory segment', () => {
  assert.equal(shortProj('C:\\Projects\\agent-board'), 'agent-board');
  assert.equal(shortProj('C:\\Projects\\agent-board\\'), 'agent-board');
  assert.equal(shortProj('/work/app'), 'app');
  assert.equal(shortProj('C:\\'), 'C:\\');
  assert.equal(shortProj(''), '');
});
