import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { requestIdMiddleware } from './request-id.middleware.js';
import { RATE_LIMIT_SERVICE } from './rate-limit.tokens.js';
import { createRateLimitMiddleware } from './rate-limit.middleware.js';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { createCsrfMiddleware } from './csrf.middleware.js';

export async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableCors({
    origin: config.trustedOrigins,
    credentials: true,
  });
  app.use(requestIdMiddleware);
  app.use(createCsrfMiddleware(config.trustedOrigins));
  app.use(createRateLimitMiddleware(app.get(RATE_LIMIT_SERVICE)));
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(config.port, '0.0.0.0');
  return app;
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('Cloud API failed to start:', error?.code || error?.name || 'UNKNOWN_ERROR');
    process.exitCode = 1;
  });
}
