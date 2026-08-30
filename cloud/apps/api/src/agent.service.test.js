const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentService } = require('./agent.service');

function createMemoryDatabase() {
  const users = new Map([
    ['user-root', { id: 'user-root' }],
    ['user-child', { id: 'user-child' }],
    ['user-grandchild', { id: 'user-grandchild' }],
    ['user-other', { id: 'user-other' }],
  ]);
  const profiles = new Map([...users.keys()].map((userId) => [userId, { userId, role: 'USER', status: 'ACTIVE', agentId: null }]));
  const agents = new Map();
  const entries = [];
  let nextAgentId = 0;
  let nextEntryId = 0;

  function selected(row, select) {
    if (!select) return { ...row, planAllowlist: Array.isArray(row.planAllowlist) ? [...row.planAllowlist] : [] };
    return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
  }

  const database = {
    $transaction: async (callback) => callback(database),
    user: {
      findUnique: async ({ where, select }) => selected(users.get(where.id), select),
    },
    userProfile: {
      findUnique: async ({ where, select }) => selected(profiles.get(where.userId), select),
      upsert: async ({ where, update, create }) => {
        const current = profiles.get(where.userId);
        const next = { ...(current || create), ...(current ? update : {}) };
        profiles.set(where.userId, next);
        return next;
      },
    },
    agent: {
      findUnique: async ({ where, select }) => {
        const row = where.id ? agents.get(where.id) : [...agents.values()].find((item) => item.userId === where.userId);
        return row ? selected(row, select) : null;
      },
      findMany: async ({ where, select }) => [...agents.values()]
        .filter((item) => (where?.parentAgentId === undefined || item.parentAgentId === where.parentAgentId))
        .map((item) => selected(item, select)),
      create: async ({ data }) => {
        const row = { id: `agent-${++nextAgentId}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        agents.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...agents.get(where.id), ...data, updatedAt: new Date() };
        agents.set(where.id, row);
        return row;
      },
    },
    agentLedgerEntry: {
      findFirst: async ({ where }) => [...entries].filter((entry) => entry.agentId === where.agentId).at(-1) || null,
      findMany: async ({ where }) => [...entries].filter((entry) => entry.agentId === where.agentId).reverse(),
      create: async ({ data }) => {
        const row = { id: `entry-${++nextEntryId}`, createdAt: new Date(), ...data };
        entries.push(row);
        return row;
      },
    },
  };
  return { database, agents, profiles, entries };
}

async function createTree(database) {
  const service = new AgentService(database, { record: async () => {} }, () => new Date('2026-08-28T12:00:00.000Z'));
  const root = await service.create({ userId: 'user-root', canCreateSubAgents: true }, { actorId: 'admin-1', requestId: 'request-root' });
  const child = await service.create({ userId: 'user-child', parentAgentId: root.id, canCreateSubAgents: true }, { actorId: 'admin-1', requestId: 'request-child' });
  const grandchild = await service.create({ userId: 'user-grandchild', parentAgentId: child.id }, { actorId: 'admin-1', requestId: 'request-grandchild' });
  return { service, root, child, grandchild };
}

test('Agent hierarchy assigns levels and prevents moving an ancestor below its descendant', async () => {
  const { database } = createMemoryDatabase();
  const { service, root, child, grandchild } = await createTree(database);

  assert.equal(root.level, 1);
  assert.equal(child.level, 2);
  assert.equal(grandchild.level, 3);
  await assert.rejects(
    service.update(root.id, { parentAgentId: grandchild.id }, { actorId: 'admin-1', requestId: 'request-cycle' }),
    (error) => error?.getResponse?.().code === 'AGENT_HIERARCHY_CYCLE',
  );
});

test('data scope includes the agent and all descendants but excludes another tree', async () => {
  const { database } = createMemoryDatabase();
  const { service, root, child, grandchild } = await createTree(database);
  const other = await service.create({ userId: 'user-other' }, { actorId: 'admin-1', requestId: 'request-other' });

  assert.deepEqual(await service.getScopeIds(root.id), [root.id, child.id, grandchild.id]);
  assert.equal(await service.isInScope(root.id, grandchild.id), true);
  assert.equal(await service.isInScope(root.id, other.id), false);
  await assert.rejects(service.assertInScope(root.id, other.id), (error) => error?.getResponse?.().code === 'AGENT_DATA_SCOPE_DENIED');
});

test('ledger is immutable, calculates balance from entries, and rejects an overdraft', async () => {
  const { database, entries } = createMemoryDatabase();
  const { service, root } = await createTree(database);

  const credit = await service.adjustLedger(root.id, { type: 'CREDIT', amount: 100, reason: 'initial allocation' }, { actorId: 'admin-1' });
  const debit = await service.adjustLedger(root.id, { type: 'DEBIT', amount: 30, reason: 'issue codes' }, { actorId: 'admin-1' });
  assert.equal(credit.balance, 100);
  assert.equal(debit.balance, 70);
  assert.equal((await service.getBalance(root.id)), 70);
  assert.equal(entries.length, 2);
  await assert.rejects(
    service.adjustLedger(root.id, { type: 'DEBIT', amount: 71, reason: 'too many codes' }, { actorId: 'admin-1' }),
    (error) => error?.getResponse?.().code === 'AGENT_INSUFFICIENT_CREDITS',
  );
  assert.equal(entries.length, 2);
});

test('creating a child requires explicit parent permission and respects depth zero', async () => {
  const { database } = createMemoryDatabase();
  const service = new AgentService(database, { record: async () => {} });
  const root = await service.create({ userId: 'user-root', maxSubAgentDepth: 0 }, { actorId: 'admin-1' });

  await assert.rejects(
    service.create({ userId: 'user-child', parentAgentId: root.id }, { actorId: 'admin-1' }),
    (error) => error?.getResponse?.().code === 'SUB_AGENT_CREATION_FORBIDDEN',
  );
  await service.update(root.id, { canCreateSubAgents: true }, { actorId: 'admin-1' });
  await assert.rejects(
    service.create({ userId: 'user-child', parentAgentId: root.id }, { actorId: 'admin-1' }),
    (error) => error?.getResponse?.().code === 'AGENT_DEPTH_EXCEEDED',
  );
});

test('an ancestor depth limit applies to the complete descendant tree', async () => {
  const { database } = createMemoryDatabase();
  const service = new AgentService(database, { record: async () => {} });
  const root = await service.create({ userId: 'user-root', canCreateSubAgents: true, maxSubAgentDepth: 1 }, { actorId: 'admin-1' });
  const child = await service.create({ userId: 'user-child', parentAgentId: root.id, canCreateSubAgents: true }, { actorId: 'admin-1' });

  await assert.rejects(
    service.create({ userId: 'user-grandchild', parentAgentId: child.id }, { actorId: 'admin-1' }),
    (error) => error?.getResponse?.().code === 'AGENT_DEPTH_EXCEEDED',
  );
});

test('admin can assign a normal user to an agent scope without changing the immutable agent identity', async () => {
  const { database, profiles } = createMemoryDatabase();
  const service = new AgentService(database, { record: async () => {} });
  const agent = await service.create({ userId: 'user-root' }, { actorId: 'admin-1' });

  const result = await service.assignUser(agent.id, 'user-other', { actorId: 'admin-1' });

  assert.deepEqual(result, { userId: 'user-other', agentId: agent.id, role: 'USER', status: 'ACTIVE' });
  assert.equal(profiles.get('user-other').agentId, agent.id);
});
