'use strict';

const { BadRequestException, NotFoundException } = require('@nestjs/common');
const { ensureUserProfile } = require('./user-profile');

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  createdAt: true,
  updatedAt: true,
  profile: { select: { role: true, status: true } },
};

const USER_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'AGENT', 'USER']);
const USER_STATUSES = new Set(['ACTIVE', 'DISABLED']);

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function normalizeUserQuery(query = {}) {
  const status = query.status == null || query.status === '' ? undefined : String(query.status).toUpperCase();
  if (status && !USER_STATUSES.has(status)) {
    throw new BadRequestException({ code: 'INVALID_USER_STATUS' });
  }

  return {
    page: positiveInteger(query.page, 1, 1000000),
    pageSize: positiveInteger(query.pageSize, 20, 100),
    search: typeof query.search === 'string' ? query.search.trim() : '',
    status,
  };
}

function serializeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    profile: user.profile
      ? { role: user.profile.role, status: user.profile.status }
      : null,
  };
}

function profileSnapshot(user) {
  return {
    status: user.profile?.status || 'ACTIVE',
    role: user.profile?.role || 'USER',
  };
}

function assertUserId(id) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new BadRequestException({ code: 'INVALID_USER_ID' });
  }
}

class AdminUsersService {
  constructor(database, audit, identity) {
    this.database = database;
    this.audit = audit;
    this.identity = identity;
  }

  async create(input = {}, context = {}) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    if (!name) throw new BadRequestException({ code: 'INVALID_USER_NAME' });
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new BadRequestException({ code: 'INVALID_USER_EMAIL' });
    if (password.length < 8) throw new BadRequestException({ code: 'INVALID_USER_PASSWORD' });
    if (!this.identity?.api?.signUpEmail) throw new Error('Identity provider is not configured');

    let result;
    try {
      result = await this.identity.api.signUpEmail({ body: { name, email, password } });
    } catch (error) {
      const code = error?.body?.code || error?.code || 'USER_CREATE_FAILED';
      throw new BadRequestException({ code: String(code) });
    }
    if (!result?.user?.id) throw new BadRequestException({ code: 'USER_CREATE_FAILED' });

    await ensureUserProfile(this.database, result.user);
    const created = await this.getById(result.user.id);
    await this.audit.record({
      ...context,
      action: 'USER_CREATED',
      targetType: 'USER',
      targetId: created.id,
      before: null,
      after: {
        id: created.id,
        name: created.name,
        email: created.email,
        role: created.profile?.role || 'USER',
        status: created.profile?.status || 'ACTIVE',
      },
    });
    return created;
  }

  async list(query) {
    const normalized = normalizeUserQuery(query);
    const where = {};
    if (normalized.search) {
      where.OR = [
        { name: { contains: normalized.search, mode: 'insensitive' } },
        { email: { contains: normalized.search, mode: 'insensitive' } },
      ];
    }
    if (normalized.status) {
      where.profile = { is: { status: normalized.status } };
    }

    const [items, total] = await Promise.all([
      this.database.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (normalized.page - 1) * normalized.pageSize,
        take: normalized.pageSize,
      }),
      this.database.user.count({ where }),
    ]);

    return {
      items: items.map(serializeUser),
      meta: { page: normalized.page, pageSize: normalized.pageSize, total },
    };
  }

  async getById(id) {
    assertUserId(id);
    const user = await this.database.user.findUnique({ where: { id }, select: USER_SELECT });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return serializeUser(user);
  }

  async setStatus(id, status, context) {
    assertUserId(id);
    const nextStatus = String(status || '').toUpperCase();
    if (!USER_STATUSES.has(nextStatus)) {
      throw new BadRequestException({ code: 'INVALID_USER_STATUS' });
    }

    return this.database.$transaction(async (transaction) => {
      const before = await transaction.user.findUnique({ where: { id }, select: USER_SELECT });
      if (!before) throw new NotFoundException({ code: 'USER_NOT_FOUND' });

      const profile = await transaction.userProfile.upsert({
        where: { userId: id },
        update: { status: nextStatus },
        create: { userId: id, role: before.profile?.role || 'USER', status: nextStatus },
        select: { role: true, status: true },
      });
      if (nextStatus === 'DISABLED') {
        const revokedAt = new Date();
        await transaction.licenseLease?.updateMany?.({
          where: { userId: id, status: 'ACTIVE' },
          data: { status: 'REVOKED', revokedAt },
        });
        await transaction.session?.deleteMany?.({ where: { userId: id } });
      }
      const after = { ...before, profile };
      await this.audit.record({
        ...context,
        action: nextStatus === 'DISABLED' ? 'USER_DISABLED' : 'USER_ENABLED',
        targetType: 'USER',
        targetId: id,
        before: profileSnapshot(before),
        after: profileSnapshot(after),
      }, transaction);
      return serializeUser(after);
    });
  }

  async update(id, changes = {}, context) {
    assertUserId(id);
    const data = {};
    if (changes.name !== undefined) {
      if (typeof changes.name !== 'string' || !changes.name.trim()) {
        throw new BadRequestException({ code: 'INVALID_USER_NAME' });
      }
      data.name = changes.name.trim();
    }
    if (changes.role !== undefined) {
      const role = String(changes.role).toUpperCase();
      if (!USER_ROLES.has(role)) throw new BadRequestException({ code: 'INVALID_USER_ROLE' });
      data.role = role;
    }
    if (!Object.keys(data).length) throw new BadRequestException({ code: 'NO_USER_CHANGES' });

    return this.database.$transaction(async (transaction) => {
      const before = await transaction.user.findUnique({ where: { id }, select: USER_SELECT });
      if (!before) throw new NotFoundException({ code: 'USER_NOT_FOUND' });

      if (data.name) {
        await transaction.user.update({ where: { id }, data: { name: data.name } });
      }
      const profile = data.role
        ? await transaction.userProfile.upsert({
          where: { userId: id },
          update: { role: data.role },
          create: { userId: id, role: data.role, status: before.profile?.status || 'ACTIVE' },
          select: { role: true, status: true },
        })
        : before.profile;
      const after = {
        ...before,
        ...(data.name ? { name: data.name } : {}),
        profile,
      };
      await this.audit.record({
        ...context,
        action: data.role ? 'USER_ROLE_UPDATED' : 'USER_UPDATED',
        targetType: 'USER',
        targetId: id,
        before: { ...profileSnapshot(before), name: before.name },
        after: { ...profileSnapshot(after), name: after.name },
      }, transaction);
      return serializeUser(after);
    });
  }
}

module.exports = { AdminUsersService, USER_SELECT, normalizeUserQuery };
