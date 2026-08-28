import { Module } from '@nestjs/common';
import { AuthModule, AuthService } from '@thallesp/nestjs-better-auth';

import { auth } from './auth.js';
import { AdminUsersController, ADMIN_USERS_SERVICE } from './admin-users.controller.js';
import { AdminAuditController, AUDIT_SERVICE } from './admin-audit.controller.js';
import { AdminGuard } from './admin.guard.js';
import { AdminUsersService } from './admin-users.service.js';
import { createAuditService } from './audit.js';
import { HealthController } from './health.controller.js';
import { PrismaModule } from './prisma.module.js';
import { UsersController } from './users.controller.js';
import { PrismaClient } from '@prisma/client';

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
  controllers: [HealthController, UsersController, AdminUsersController, AdminAuditController],
  providers: [
    AdminGuard,
    {
      provide: AUDIT_SERVICE,
      useFactory: (database: PrismaClient) => createAuditService(database),
      inject: [PrismaClient],
    },
    {
      provide: ADMIN_USERS_SERVICE,
      useFactory: (database: PrismaClient, audit: ReturnType<typeof createAuditService>, identity: AuthService<typeof auth>) => new AdminUsersService(database, audit, identity),
      inject: [PrismaClient, AUDIT_SERVICE, AuthService],
    },
  ],
})
export class AppModule {}
