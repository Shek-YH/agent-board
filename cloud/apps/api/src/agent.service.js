'use strict';

const { BadRequestException, NotFoundException } = require('@nestjs/common');

const AGENT_STATUSES = new Set(['ACTIVE', 'SUSPENDED', 'DISABLED']);
const LEDGER_TYPES = new Set(['CREDIT', 'DEBIT', 'REFUND', 'ADJUSTMENT']);
const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

function bad(code) {
  throw new BadRequestException({ code });
}

function assertId(value, code) {
  if (typeof value !== 'string' || !value.trim()) bad(code);
  return value.trim();
}

function requiredText(value, code) {
  if (typeof value !== 'string' || !value.trim()) bad(code);
  return value.trim();
}

function parseNonNegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 2147483647) bad(code);
  return number;
}

function parseLedgerAmount(type, value) {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < (type === 'ADJUSTMENT' ? -2147483647 : 1) || amount > 2147483647 || (type === 'ADJUSTMENT' && amount === 0)) {
    bad('INVALID_LEDGER_AMOUNT');
  }
  return amount;
}

function normalizeStatus(value) {
  const status = String(value || 'ACTIVE').toUpperCase();
  if (!AGENT_STATUSES.has(status)) bad('INVALID_AGENT_STATUS');
  return status;
}

function normalizePlanAllowlist(value) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) bad('INVALID_AGENT_PLAN_ALLOWLIST');
  return [...new Set(value.map((item) => assertId(String(item), 'INVALID_AGENT_PLAN_ID')))].sort();
}

function serializeAgent(agent) {
  if (!agent) return null;
  return {
    id: agent.id,
    userId: agent.userId,
    parentAgentId: agent.parentAgentId,
    level: agent.level,
    status: agent.status,
    canCreateSubAgents: agent.canCreateSubAgents,
    maxSubAgentDepth: agent.maxSubAgentDepth,
    planAllowlist: Array.isArray(agent.planAllowlist) ? agent.planAllowlist : [],
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function serializeLedgerEntry(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    agentId: entry.agentId,
    type: entry.type,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    reason: entry.reason,
    relatedBatchId: entry.relatedBatchId,
    relatedCodeId: entry.relatedCodeId,
    operatorId: entry.operatorId,
    createdAt: entry.createdAt,
  };
}

function ledgerDelta(type, amount) {
  if (type === 'DEBIT') return -amount;
  return amount;
}

class AgentService {
  constructor(database, audit, clock = () => new Date()) {
    this.database = database;
    this.audit = audit;
    this.clock = clock;
  }

  async create(input = {}, context = {}) {
    const userId = assertId(input.userId, 'INVALID_AGENT_USER_ID');
    const parentAgentId = input.parentAgentId ? assertId(input.parentAgentId, 'INVALID_PARENT_AGENT_ID') : null;
    const data = {
      status: normalizeStatus(input.status),
      canCreateSubAgents: input.canCreateSubAgents === true,
      maxSubAgentDepth: input.maxSubAgentDepth === undefined || input.maxSubAgentDepth === null || input.maxSubAgentDepth === ''
        ? null
        : parseNonNegativeInteger(input.maxSubAgentDepth, 'INVALID_AGENT_DEPTH'),
      planAllowlist: normalizePlanAllowlist(input.planAllowlist),
    };

    return this.database.$transaction(async (transaction) => {
      const user = await transaction.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
      const existing = await transaction.agent.findUnique({ where: { userId } });
      if (existing) bad('AGENT_ALREADY_EXISTS');

      const profile = await transaction.userProfile.findUnique({ where: { userId }, select: { role: true, status: true } });
      if (profile && ADMIN_ROLES.has(profile.role)) bad('AGENT_USER_ROLE_CONFLICT');
      const parent = parentAgentId ? await transaction.agent.findUnique({ where: { id: parentAgentId } }) : null;
      if (parentAgentId && !parent) throw new NotFoundException({ code: 'PARENT_AGENT_NOT_FOUND' });
      if (parent) {
        this.assertCanCreateChild(parent);
        await this.assertDepthWithinAncestors(transaction, parent);
      }

      const agent = await transaction.agent.create({
        data: {
          userId,
          parentAgentId,
          level: parent ? parent.level + 1 : 1,
          ...data,
        },
      });
      await transaction.userProfile.upsert({
        where: { userId },
        update: { role: 'AGENT', status: profile?.status || 'ACTIVE', agentId: agent.id },
        create: { userId, role: 'AGENT', status: 'ACTIVE', agentId: agent.id },
      });
      await this.audit?.record?.({
        ...context,
        action: 'AGENT_CREATED',
        targetType: 'AGENT',
        targetId: agent.id,
        before: null,
        after: serializeAgent(agent),
      }, transaction);
      return serializeAgent(agent);
    });
  }

  async list(query = {}) {
    const where = {};
    if (query.status) where.status = normalizeStatus(query.status);
    if (query.parentAgentId !== undefined) where.parentAgentId = query.parentAgentId ? assertId(query.parentAgentId, 'INVALID_PARENT_AGENT_ID') : null;
    const agents = await this.database.agent.findMany({ where, orderBy: { createdAt: 'desc' } });
    return { items: agents.map(serializeAgent) };
  }

  async getById(id) {
    const agentId = assertId(id, 'INVALID_AGENT_ID');
    const agent = await this.database.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });
    return serializeAgent(agent);
  }

  async getByUserId(userId) {
    const agent = await this.database.agent.findUnique({ where: { userId: assertId(userId, 'INVALID_AGENT_USER_ID') } });
    return serializeAgent(agent);
  }

  async previewMove(id, /** @type {string | null | undefined} */ proposedParentId = null) {
    const agentId = assertId(id, 'INVALID_AGENT_ID');
    const parentAgentId = proposedParentId ? assertId(proposedParentId, 'INVALID_PARENT_AGENT_ID') : null;
    const agent = await this.database.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });

    let parent = null;
    if (parentAgentId) {
      if (parentAgentId === agentId || await this.isDescendant(this.database, agentId, parentAgentId)) bad('AGENT_HIERARCHY_CYCLE');
      parent = await this.database.agent.findUnique({ where: { id: parentAgentId } });
      if (!parent) throw new NotFoundException({ code: 'PARENT_AGENT_NOT_FOUND' });
      this.assertCanCreateChild(parent);
      await this.assertDepthWithinAncestors(this.database, parent);
    }

    const proposedLevel = parent ? parent.level + 1 : 1;
    const affectedAgents = [];
    const queue = [agent];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || visited.has(current.id)) continue;
      visited.add(current.id);
      affectedAgents.push({
        id: current.id,
        currentLevel: current.level,
        proposedLevel: proposedLevel + (current.level - agent.level),
      });
      const children = await this.database.agent.findMany({ where: { parentAgentId: current.id } });
      queue.push(...children);
    }

    return {
      agentId,
      currentParentAgentId: agent.parentAgentId,
      proposedParentAgentId: parentAgentId,
      currentLevel: agent.level,
      proposedLevel,
      affectedAgents,
    };
  }

  async update(id, changes = {}, context = {}) {
    const agentId = assertId(id, 'INVALID_AGENT_ID');
    return this.database.$transaction(async (transaction) => {
      const before = await transaction.agent.findUnique({ where: { id: agentId } });
      if (!before) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });
      const data = {};
      if (changes.status !== undefined) data.status = normalizeStatus(changes.status);
      if (changes.canCreateSubAgents !== undefined) data.canCreateSubAgents = changes.canCreateSubAgents === true;
      if (changes.maxSubAgentDepth !== undefined) {
        data.maxSubAgentDepth = changes.maxSubAgentDepth === null || changes.maxSubAgentDepth === ''
          ? null
          : parseNonNegativeInteger(changes.maxSubAgentDepth, 'INVALID_AGENT_DEPTH');
      }
      if (changes.planAllowlist !== undefined) data.planAllowlist = normalizePlanAllowlist(changes.planAllowlist);

      const parentChanged = Object.prototype.hasOwnProperty.call(changes, 'parentAgentId');
      if (parentChanged) {
        const parentAgentId = changes.parentAgentId ? assertId(changes.parentAgentId, 'INVALID_PARENT_AGENT_ID') : null;
        if (parentAgentId === agentId) bad('AGENT_HIERARCHY_CYCLE');
        const parent = parentAgentId ? await transaction.agent.findUnique({ where: { id: parentAgentId } }) : null;
        if (parentAgentId && !parent) throw new NotFoundException({ code: 'PARENT_AGENT_NOT_FOUND' });
          if (parent) {
            if (parent.id === agentId || await this.isDescendant(transaction, agentId, parent.id)) bad('AGENT_HIERARCHY_CYCLE');
            this.assertCanCreateChild(parent);
            await this.assertDepthWithinAncestors(transaction, parent);
            data.level = parent.level + 1;
        } else {
          data.level = 1;
        }
        data.parentAgentId = parentAgentId;
      }

      const agent = Object.keys(data).length ? await transaction.agent.update({ where: { id: agentId }, data }) : before;
      if (parentChanged) await this.relevelChildren(transaction, agent.id, agent.level);
      await this.audit?.record?.({
        ...context,
        action: parentChanged ? 'AGENT_PARENT_UPDATED' : 'AGENT_UPDATED',
        targetType: 'AGENT',
        targetId: agent.id,
        before: serializeAgent(before),
        after: serializeAgent(agent),
      }, transaction);
      return serializeAgent(agent);
    });
  }

  async assignUser(agentId, userId, context = {}) {
    const id = assertId(agentId, 'INVALID_AGENT_ID');
    const targetUserId = assertId(userId, 'INVALID_USER_ID');
    return this.database.$transaction(async (transaction) => {
      const agent = await transaction.agent.findUnique({ where: { id } });
      if (!agent) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });
      if (agent.status !== 'ACTIVE') bad('AGENT_NOT_ACTIVE');
      const user = await transaction.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
      if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
      const before = await transaction.userProfile.findUnique({ where: { userId: targetUserId }, select: { role: true, status: true, agentId: true } });
      if (before && ADMIN_ROLES.has(before.role)) bad('AGENT_USER_ROLE_CONFLICT');
      if (before?.role === 'AGENT' && before.agentId !== id) bad('AGENT_USER_ROLE_CONFLICT');
      const profile = await transaction.userProfile.upsert({
        where: { userId: targetUserId },
        update: { agentId: id },
        create: { userId: targetUserId, role: 'USER', status: 'ACTIVE', agentId: id },
        select: { role: true, status: true, agentId: true },
      });
      await this.audit?.record?.({
        ...context,
        action: 'AGENT_USER_ASSIGNED',
        targetType: 'USER',
        targetId: targetUserId,
        before: before ? { agentId: before.agentId, role: before.role } : null,
        after: { agentId: profile.agentId, role: profile.role },
      }, transaction);
      return { userId: targetUserId, agentId: profile.agentId, role: profile.role, status: profile.status };
    });
  }

  async getScopeIds(rootAgentId, transaction = this.database) {
    const rootId = assertId(rootAgentId, 'INVALID_AGENT_ID');
    const result = [];
    const queue = [rootId];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      result.push(current);
      const children = await transaction.agent.findMany({ where: { parentAgentId: current }, select: { id: true } });
      for (const child of children) if (!visited.has(child.id)) queue.push(child.id);
    }
    return result;
  }

  async isInScope(rootAgentId, targetAgentId, transaction = this.database) {
    const rootId = assertId(rootAgentId, 'INVALID_AGENT_ID');
    let currentId = assertId(targetAgentId, 'INVALID_AGENT_ID');
    const visited = new Set();
    while (currentId && !visited.has(currentId)) {
      if (currentId === rootId) return true;
      visited.add(currentId);
      const current = await transaction.agent.findUnique({ where: { id: currentId }, select: { parentAgentId: true } });
      if (!current) return false;
      currentId = current.parentAgentId;
    }
    return false;
  }

  async assertInScope(rootAgentId, targetAgentId, transaction = this.database) {
    if (!await this.isInScope(rootAgentId, targetAgentId, transaction)) bad('AGENT_DATA_SCOPE_DENIED');
    return true;
  }

  async isPlanAllowed(agentId, planId, transaction = this.database) {
    const agent = await transaction.agent.findUnique({ where: { id: assertId(agentId, 'INVALID_AGENT_ID') }, select: { planAllowlist: true } });
    if (!agent) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });
    const allowlist = Array.isArray(agent.planAllowlist) ? agent.planAllowlist : [];
    return allowlist.length === 0 || allowlist.includes(planId);
  }

  async chargeForGrantInTransaction(transaction, agentId, planId, context = {}) {
    const id = assertId(agentId, 'INVALID_AGENT_ID');
    const targetPlanId = assertId(planId, 'INVALID_PLAN_ID');
    const agent = await transaction.agent.findUnique({ where: { id } });
    if (!agent) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });
    if (agent.status !== 'ACTIVE') bad('AGENT_NOT_ACTIVE');
    const plan = await transaction.plan.findUnique({ where: { id: targetPlanId } });
    if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
    if (plan.status !== 'ACTIVE') bad('PLAN_DISABLED');
    const allowlist = Array.isArray(agent.planAllowlist) ? agent.planAllowlist : [];
    if (allowlist.length > 0 && !allowlist.includes(targetPlanId)) bad('AGENT_PLAN_NOT_ALLOWED');
    const cost = Number(plan.agentCostCredits || 0);
    if (!Number.isInteger(cost) || cost < 0) bad('INVALID_AGENT_COST');
    if (cost > 0) {
      const charged = await this.adjustLedgerInTransaction(transaction, id, {
        type: 'DEBIT',
        amount: cost,
        reason: `AGENT_GRANT:${targetPlanId}`,
      }, context);
      return { plan, balance: charged.balance };
    }
    return { plan, balance: await this.getBalance(id, transaction) };
  }

  async getBalance(agentId, transaction = this.database) {
    const id = assertId(agentId, 'INVALID_AGENT_ID');
    const latest = await transaction.agentLedgerEntry.findFirst({ where: { agentId: id }, orderBy: { createdAt: 'desc' } });
    return latest?.balanceAfter || 0;
  }

  async listLedger(agentId, query = {}) {
    const id = assertId(agentId, 'INVALID_AGENT_ID');
    const limit = Math.min(100, Math.max(1, Number.isInteger(Number(query.limit)) ? Number(query.limit) : 50));
    const entries = await this.database.agentLedgerEntry.findMany({
      where: { agentId: id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return { items: entries.map(serializeLedgerEntry), balance: await this.getBalance(id) };
  }

  async adjustLedger(agentId, input = {}, context = {}) {
    const id = assertId(agentId, 'INVALID_AGENT_ID');
    const type = String(input.type || '').toUpperCase();
    if (!LEDGER_TYPES.has(type)) bad('INVALID_LEDGER_TYPE');
    const amount = parseLedgerAmount(type, input.amount);
    const reason = requiredText(input.reason, 'INVALID_LEDGER_REASON');
    return this.database.$transaction((transaction) => this.adjustLedgerInTransaction(transaction, id, {
      type, amount, reason, relatedBatchId: input.relatedBatchId, relatedCodeId: input.relatedCodeId,
    }, context), { isolationLevel: 'Serializable' });
  }

  async adjustLedgerInTransaction(transaction, agentId, input, context = {}) {
    const id = assertId(agentId, 'INVALID_AGENT_ID');
    const agent = await transaction.agent.findUnique({ where: { id } });
    if (!agent) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });
    if (agent.status !== 'ACTIVE') bad('AGENT_NOT_ACTIVE');
    const type = String(input.type || '').toUpperCase();
    if (!LEDGER_TYPES.has(type)) bad('INVALID_LEDGER_TYPE');
    const amount = parseLedgerAmount(type, input.amount);
    const reason = requiredText(input.reason, 'INVALID_LEDGER_REASON');
    const balanceBefore = await this.getBalance(id, transaction);
    const balanceAfter = balanceBefore + ledgerDelta(type, amount);
    if (balanceAfter < 0) bad('AGENT_INSUFFICIENT_CREDITS');
    const entry = await transaction.agentLedgerEntry.create({
      data: {
        agentId: id,
        type,
        amount,
        balanceAfter,
        reason,
        relatedBatchId: input.relatedBatchId || null,
        relatedCodeId: input.relatedCodeId || null,
        operatorId: context.actorId || context.operatorId || null,
      },
    });
    await this.audit?.record?.({
      ...context,
      action: 'AGENT_LEDGER_ADJUSTED',
      targetType: 'AGENT',
      targetId: id,
      before: { balance: balanceBefore },
      after: { balance: balanceAfter, type, amount, reason },
    }, transaction);
    return { entry: serializeLedgerEntry(entry), balance: balanceAfter };
  }

  assertCanCreateChild(agent) {
    if (agent.status !== 'ACTIVE') bad('AGENT_NOT_ACTIVE');
    if (!agent.canCreateSubAgents) bad('SUB_AGENT_CREATION_FORBIDDEN');
    if (agent.maxSubAgentDepth !== null && agent.maxSubAgentDepth !== undefined && agent.level + 1 > agent.level + agent.maxSubAgentDepth) {
      bad('AGENT_DEPTH_EXCEEDED');
    }
  }

  async isDescendant(transaction, ancestorId, candidateId) {
    let currentId = candidateId;
    const visited = new Set();
    while (currentId && !visited.has(currentId)) {
      if (currentId === ancestorId) return true;
      visited.add(currentId);
      const current = await transaction.agent.findUnique({ where: { id: currentId }, select: { parentAgentId: true } });
      currentId = current?.parentAgentId;
    }
    return false;
  }

  async assertDepthWithinAncestors(transaction, parent) {
    const proposedLevel = parent.level + 1;
    let current = parent;
    const visited = new Set();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.maxSubAgentDepth !== null && current.maxSubAgentDepth !== undefined && proposedLevel > current.level + current.maxSubAgentDepth) {
        bad('AGENT_DEPTH_EXCEEDED');
      }
      if (!current.parentAgentId) break;
      current = await transaction.agent.findUnique({ where: { id: current.parentAgentId } });
    }
  }

  async relevelChildren(transaction, parentId, parentLevel) {
    const children = await transaction.agent.findMany({ where: { parentAgentId: parentId }, select: { id: true } });
    for (const child of children) {
      await transaction.agent.update({ where: { id: child.id }, data: { level: parentLevel + 1 } });
      await this.relevelChildren(transaction, child.id, parentLevel + 1);
    }
  }
}

module.exports = {
  AgentService,
  AGENT_STATUSES,
  LEDGER_TYPES,
  serializeAgent,
  serializeLedgerEntry,
};
