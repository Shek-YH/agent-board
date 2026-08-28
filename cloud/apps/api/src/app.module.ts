import { Module } from '@nestjs/common';
import { AuthModule } from '@thallesp/nestjs-better-auth';

import { auth } from './auth.js';
import { HealthController } from './health.controller.js';
import { PrismaModule } from './prisma.module.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule.forRoot({
      auth,
      bodyParser: {
        json: { limit: '1mb' },
        urlencoded: { limit: '1mb', extended: true },
      },
    }),
  ],
  controllers: [HealthController, UsersController],
})
export class AppModule {}
