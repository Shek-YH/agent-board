const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'agent.controller.ts'), 'utf8');

test('agent sub-agent creation requires the target user to already be in the caller scope', () => {
  const start = source.indexOf("@Post('sub-agents')");
  const end = source.indexOf("@Get('ledger')", start);
  const handler = source.slice(start, end);
  assert.match(handler, /userProfile\.findUnique/);
  assert.match(handler, /AGENT_USER_NOT_IN_SCOPE/);
  assert.match(handler, /assertInScope\(request\.agent\.id, profile\.agentId\)/);
  assert.ok(handler.indexOf('assertInScope') < handler.indexOf('agents.create'));
});
