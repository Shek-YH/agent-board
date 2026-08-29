'use strict';

class DatabaseUnavailableError extends Error {
  constructor() {
    super('Database is unavailable');
    this.name = 'DatabaseUnavailableError';
    this.code = 'DATABASE_UNAVAILABLE';
    this.statusCode = 503;
  }
}

function createHealthService({ checkDatabase }) {
  if (typeof checkDatabase !== 'function') {
    throw new TypeError('checkDatabase must be a function');
  }

  return {
    async live() {
      return { status: 'healthy' };
    },

    async ready() {
      try {
        await checkDatabase();
        return { status: 'healthy', database: 'healthy' };
      } catch {
        throw new DatabaseUnavailableError();
      }
    },
  };
}

module.exports = { DatabaseUnavailableError, createHealthService };
