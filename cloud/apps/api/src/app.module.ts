import { Module } from '@nestjs/common';
import { AuthModule, AuthService } from '@thallesp/nestjs-better-auth';

import { auth } from './auth.js';
import { AdminUsersController, ADMIN_USERS_SERVICE } from './admin-users.controller.js';
import { AdminAuditController, AUDIT_SERVICE } from './admin-audit.controller.js';
import { AdminEntitlementsController, ENTITLEMENT_SERVICE } from './admin-entitlements.controller.js';
import { AdminPlansController, AdminProductsController, CATALOG_SERVICE } from './admin-catalog.controller.js';
import { AdminRedemptionBatchesController, AdminRedemptionCodesController, REDEMPTION_SERVICE } from './admin-redemption.controller.js';
import { AdminAgentsController } from './admin-agents.controller.js';
import { AgentController } from './agent.controller.js';
import { AgentGuard } from './agent.guard.js';
import { AgentService } from './agent.service.js';
import { AGENT_SERVICE } from './agent.tokens.js';
import { DeviceController, DEVICE_SERVICE } from './device.controller.js';
import { DeviceService } from './device.service.js';
import { AdminDevicesController } from './admin-devices.controller.js';
import { LicenseController, LEASE_SERVICE } from './license.controller.js';
import { LeaseService } from './lease.service.js';
import { AdminGuard } from './admin.guard.js';
import { AdminUsersService } from './admin-users.service.js';
import { CatalogService } from './catalog.service.js';
import { EntitlementService } from './entitlement.service.js';
import { RedemptionController } from './redemption.controller.js';
import { RedemptionService } from './redemption.service.js';
import { loadConfig } from './config.js';
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
  controllers: [
    HealthController,
    UsersController,
    AdminUsersController,
    AdminAuditController,
    AdminProductsController,
    AdminPlansController,
    AdminEntitlementsController,
    AdminRedemptionBatchesController,
    AdminRedemptionCodesController,
    AdminAgentsController,
    AgentController,
    DeviceController,
    AdminDevicesController,
    LicenseController,
    RedemptionController,
  ],
  providers: [
    AdminGuard,
    AgentGuard,
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
    {
      provide: CATALOG_SERVICE,
      useFactory: (database: PrismaClient, audit: ReturnType<typeof createAuditService>) => new CatalogService(database, audit),
      inject: [PrismaClient, AUDIT_SERVICE],
    },
    {
      provide: ENTITLEMENT_SERVICE,
      useFactory: (database: PrismaClient, audit: ReturnType<typeof createAuditService>) => new EntitlementService(database, audit),
      inject: [PrismaClient, AUDIT_SERVICE],
    },
    {
      provide: AGENT_SERVICE,
      useFactory: (database: PrismaClient, audit: ReturnType<typeof createAuditService>) => new AgentService(database, audit),
      inject: [PrismaClient, AUDIT_SERVICE],
    },
    {
      provide: DEVICE_SERVICE,
      useFactory: (database: PrismaClient, audit: ReturnType<typeof createAuditService>) => new DeviceService(database, audit),
      inject: [PrismaClient, AUDIT_SERVICE],
    },
    {
      provide: LEASE_SERVICE,
      useFactory: (database: PrismaClient, audit: ReturnType<typeof createAuditService>) => new LeaseService(database, audit),
      inject: [PrismaClient, AUDIT_SERVICE],
    },
    {
      provide: REDEMPTION_SERVICE,
      useFactory: (
        database: PrismaClient,
        entitlements: EntitlementService,
        audit: ReturnType<typeof createAuditService>,
        agents: AgentService,
      ) => new RedemptionService(database, entitlements, audit, loadConfig().redemptionPepper, undefined, undefined, agents),
      inject: [PrismaClient, ENTITLEMENT_SERVICE, AUDIT_SERVICE, AGENT_SERVICE],
    },
  ],
})
export class AppModule {}
