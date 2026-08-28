import { betterAuth } from 'better-auth/minimal';
import { prismaAdapter } from '@better-auth/prisma-adapter';

import { loadConfig } from './config.js';
import { buildAuthConfig } from './auth-config.js';
import { prisma } from './database.js';
import { ensureUserProfile } from './user-profile.js';

const config = loadConfig();

export const auth = betterAuth({
  ...buildAuthConfig(config),
  basePath: '/v1/auth',
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  advanced: {
    database: { joins: true },
    useSecureCookies: config.nodeEnv === 'production',
  },
  emailAndPassword: { enabled: true },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => ensureUserProfile(prisma, user),
      },
    },
  },
});
