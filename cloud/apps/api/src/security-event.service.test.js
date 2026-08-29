'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SecurityEventService } = require('./security-event.service');

function makeDatabase() {
  const events = [{
    id: 'event-1', userId: 'user-1', deviceId: 'device-1', agentId: null, type: 'INVALID_DEVICE_SIGNATURE', severity: 'HIGH',
    ip: '127.0.0.1', metadataSanitized: { route: '/v1/license/acquire' }, status: 'OPEN', createdAt: new Date('2026-08-28T12:00:00.000Z'), resolvedAt: null, resolvedBy: null,
  }];
  return {
    events,
    database: {
      securityEvent: {
        create: async ({ data }) => { const event = { id: `event-${events.length + 1}`, ...data, resolvedAt: null, resolvedBy: null }; events.push(event); return event; },
        findMany: async () => events,
        count: async () => events.length,
        findUnique: async ({ where }) => events.find((event) => event.id === where.id) || null,
        update: async ({ where, data }) => { const event = events.find((item) => item.id === where.id); Object.assign(event, data); return event; },
      },
    },
    audit: { records: [], record(input) { this.records.push(input); } },
  };
}

test('security events sanitize secret-like metadata and support filtered listing', async () => {
  const state = makeDatabase();
  const service = new SecurityEventService(state.database, state.audit);
  const event = await service.create({
    userId: 'user-1', type: 'RATE_LIMITED', severity: 'MEDIUM', ip: '127.0.0.1',
    metadata: { route: '/v1/auth/sign-in/email', password: 'hidden', nested: { token: 'hidden', retryAfter: 3 } },
  });

  assert.equal(event.metadataSanitized.password, undefined);
  assert.equal(event.metadataSanitized.nested.token, undefined);
  assert.equal(event.metadataSanitized.nested.retryAfter, 3);
  const listed = await service.list({ status: 'OPEN', type: 'RATE_LIMITED' });
  assert.equal(listed.items.length, 2);
  assert.equal(listed.meta.total, 2);
});

test('admin can resolve an open security event and the action is audited', async () => {
  const state = makeDatabase();
  const service = new SecurityEventService(state.database, state.audit, () => new Date('2026-08-28T13:00:00.000Z'));
  const resolved = await service.resolve('event-1', { actorId: 'admin-1', requestId: 'request-1' });

  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.resolvedBy, 'admin-1');
  assert.equal(state.audit.records[0].action, 'SECURITY_EVENT_RESOLVED');
});
