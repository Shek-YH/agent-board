'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createResearcher } = require('./researcher');

test('researcher reads bounded local material first and never uses external search without researchRead', async () => {
  const calls = [];
  const researcher = createResearcher({
    readLocal: async (request) => {
      calls.push(['local', request]);
      return {
        sources: [{ kind: 'local', path: 'docs/README.md', title: 'README', content: 'API 使用 node --test 验证' }],
        findings: { evidence: ['node --test 通过'] },
      };
    },
    searchExternal: async () => { calls.push(['external']); return []; },
  });

  const result = await researcher.research({
    projectPath: 'C:\\work\\app', goal: '补充 API 测试', fields: ['evidence'],
    permissionSnapshot: { researchRead: false },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.confidenceLevel, 'high');
  assert.deepEqual(result.findings.evidence, ['node --test 通过']);
  assert.equal(calls[0][0], 'local');
  assert.equal(calls.some(([kind]) => kind === 'external'), false);
  assert.equal(result.sources.length, 1);
});

test('researcher requires permission and domain allowlist before fetching external sources', async () => {
  let searches = 0;
  let fetches = 0;
  const researcher = createResearcher({
    readLocal: async () => ({ findings: {}, unresolvedQuestions: ['需要公开 API 版本'] }),
    searchExternal: async () => { searches += 1; return [{ url: 'https://docs.example.com/api?token=secret', title: 'API docs', findings: { dod: ['接口返回 200'] } }]; },
    fetchSource: async (source) => { fetches += 1; return source; },
  });

  const denied = await researcher.research({
    projectPath: 'C:\\work\\app', goal: '确认 API 版本', fields: ['dod'],
    permissionSnapshot: { researchRead: false, allowedResearchDomains: ['docs.example.com'] },
  });
  assert.equal(denied.status, 'permission_required');
  assert.equal(denied.errorCode, 'RESEARCH_PERMISSION_REQUIRED');
  assert.equal(searches, 0);
  assert.equal(fetches, 0);

  const allowed = await researcher.research({
    projectPath: 'C:\\work\\app', goal: '确认 API 版本', fields: ['dod'],
    permissionSnapshot: { researchRead: true, allowedResearchDomains: ['docs.example.com'] },
  });
  assert.equal(allowed.status, 'completed');
  assert.equal(searches, 1);
  assert.equal(fetches, 1);
  assert.deepEqual(allowed.findings.dod, ['接口返回 200']);
  assert.equal(allowed.sources[0].url, 'https://docs.example.com/api');
  assert.doesNotMatch(JSON.stringify(allowed), /token=secret/);
});

test('researcher fails closed on conflicts, source limits, timeouts, and never returns secrets or raw responses', async () => {
  let clock = 0;
  const researcher = createResearcher({
    now: () => clock,
    limits: { maxSources: 1, maxExternalPages: 1, maxResearchRuntimeMs: 1_000 },
    readLocal: async () => ({
      sources: [{ kind: 'local', path: 'README.md', title: 'README', content: 'TOKEN=local-secret' }],
      findings: { dod: ['本地通过'] },
      unresolvedQuestions: ['需要外部资料确认'],
    }),
    searchExternal: async () => {
      clock = 2_000;
      return [{ url: 'https://docs.example.com/a', title: 'A', findings: { dod: ['外部通过'] } }];
    },
  });
  const timedOut = await researcher.research({
    projectPath: 'C:\\work\\app', goal: '验证完成条件', fields: ['dod'],
    permissionSnapshot: { researchRead: true, allowedResearchDomains: ['docs.example.com'] },
  });
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.errorCode, 'RESEARCH_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(timedOut), /local-secret|TOKEN=/i);
  assert.equal(JSON.stringify(timedOut).includes('raw'), false);

  const conflict = await createResearcher({
    readLocal: async () => ({
      sources: [
        { kind: 'local', path: 'a.md', title: 'A', findings: { dod: ['必须通过单元测试'] } },
        { kind: 'local', path: 'b.md', title: 'B', findings: { dod: ['无需测试'] } },
      ],
    }),
    limits: { maxSources: 8 },
  }).research({ projectPath: 'C:\\work\\app', goal: '判断验收标准', fields: ['dod'] });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.errorCode, 'RESEARCH_CONFLICT');
});
