import { betterAuth } from 'better-auth/minimal';
import { prismaAdapter } from '@better-auth/prisma-adapter';

import { loadConfig } from './config.js';
import { buildAuthConfig } from './auth-config.js';
import { prisma } from './database.js';
import { ensureUserProfile } from './user-profile.js';
import { bearer } from 'better-auth/plugins/bearer';

const config = loadConfig();
const authConfig = buildAuthConfig(config);

export const auth = betterAuth({
  ...authConfig,
  basePath: '/v1/auth',
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  advanced: {
    database: { joins: true },
    useSecureCookies: config.nodeEnv === 'production',
  },
  emailAndPassword: { ...authConfig.emailAndPassword, enabled: true },
  plugins: [bearer()],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => ensureUserProfile(prisma, user),
      },
    },
  },
});
