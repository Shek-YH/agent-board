import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { requestIdMiddleware } from './request-id.middleware.js';

export async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableCors({
    origin: config.trustedOrigins,
    credentials: true,
  });
  app.use(requestIdMiddleware);
  await app.listen(config.port, '0.0.0.0');
  return app;
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('Cloud API failed to start:', error?.code || error?.name || 'UNKNOWN_ERROR');
    process.exitCode = 1;
  });
}
