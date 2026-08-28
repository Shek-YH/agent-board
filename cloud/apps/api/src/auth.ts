import { betterAuth } from 'better-auth/minimal';
import { prismaAdapter } from '@better-auth/prisma-adapter';

import { loadConfig } from './config.js';
import { buildAuthConfig } from './auth-config.js';
import { prisma } from './database.js';

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
});
