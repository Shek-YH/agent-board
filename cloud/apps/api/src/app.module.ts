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
import { AdminOnlineSessionsController } from './admin-online-sessions.controller.js';
import { AdminDashboardController } from './admin-dashboard.controller.js';
import { AdminVersionPolicyController, VERSION_POLICY_SERVICE } from './admin-version-policy.controller.js';
import { SecurityEventController, SECURITY_EVENT_SERVICE } from './security-event.controller.js';
import { LicenseController, LEASE_SERVICE } from './license.controller.js';
import { LeaseService } from './lease.service.js';
import { createOfflineGrantService } from './offline-grant.service.js';
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
import { ClientVersionPolicyService } from './version-policy.service.js';
import { createSecurityEventService, SecurityEventService } from './security-event.service.js';
import { RATE_LIMIT_SERVICE } from './rate-limit.tokens.js';
import { createRateLimitService } from './rate-limit.service.js';
import { PrismaClient } from '@prisma/client';
import { DesktopAuthController, DESKTOP_AUTH_SERVICE } from './desktop-auth.controller.js';
import { DesktopAuthService } from './desktop-auth.service.js';
import { createRegistrationMiddleware } from './registration.middleware.js';
import { RegistrationController, REGISTRATION_SERVICE } from './registration.controller.js';
import { RegistrationService } from './registration.service.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule.forRoot({
      auth,
      bodyParser: {
        json: { limit: '1mb' },
        urlencoded: { limit: '1mb', extended: true },
      },
      middleware: createRegistrationMiddleware(loadConfig().registrationMode),
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
    AdminOnlineSessionsController,
    AdminDashboardController,
    AdminVersionPolicyController,
    SecurityEventController,
    LicenseController,
    RedemptionController,
    DesktopAuthController,
    RegistrationController,
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
      provide: SECURITY_EVENT_SERVICE,
      useFactory: (database: PrismaClient, audit: ReturnType<typeof createAuditService>) => createSecurityEventService(database, audit),
      inject: [PrismaClient, AUDIT_SERVICE],
    },
    {
      provide: RATE_LIMIT_SERVICE,
      useFactory: (securityEvents: SecurityEventService) => createRateLimitService({
        onLimited: (event: any) => securityEvents.create({
          ...event,
          type: event.metadata?.route === 'login' ? 'BRUTE_FORCE_LOGIN' : event.type,
        }).catch(() => undefined),
      }),
      inject: [SECURITY_EVENT_SERVICE],
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
      useFactory: (database: PrismaClient, audit: ReturnType<typeof createAuditService>, securityEvents: SecurityEventService) => new DeviceService(database, audit, undefined, securityEvents),
      inject: [PrismaClient, AUDIT_SERVICE, SECURITY_EVENT_SERVICE],
    },
    {
      provide: VERSION_POLICY_SERVICE,
      useFactory: (database: PrismaClient, audit: ReturnType<typeof createAuditService>) => new ClientVersionPolicyService(database, audit),
      inject: [PrismaClient, AUDIT_SERVICE],
    },
    {
      provide: 'OFFLINE_GRANT_SERVICE',
      useFactory: () => {
        const config = loadConfig();
        const signingOptions = { privateKey: config.licenseSigningPrivateKey, keyId: config.licenseSigningKeyId };
        return createOfflineGrantService(signingOptions);
      },
    },
    {
      provide: LEASE_SERVICE,
      useFactory: (
        database: PrismaClient,
        audit: ReturnType<typeof createAuditService>,
        offlineGrants: ReturnType<typeof createOfflineGrantService>,
        versionPolicies: ClientVersionPolicyService,
        securityEvents: SecurityEventService,
      ) => new LeaseService(database, audit, undefined, { offlineGrants, versionPolicies, securityEvents }),
      inject: [PrismaClient, AUDIT_SERVICE, 'OFFLINE_GRANT_SERVICE', VERSION_POLICY_SERVICE, SECURITY_EVENT_SERVICE],
    },
    {
      provide: REDEMPTION_SERVICE,
      useFactory: (
        database: PrismaClient,
        entitlements: EntitlementService,
        audit: ReturnType<typeof createAuditService>,
        agents: AgentService,
        securityEvents: SecurityEventService,
      ) => new RedemptionService(database, entitlements, audit, loadConfig().redemptionPepper, undefined, undefined, agents, securityEvents),
      inject: [PrismaClient, ENTITLEMENT_SERVICE, AUDIT_SERVICE, AGENT_SERVICE, SECURITY_EVENT_SERVICE],
    },
    {
      provide: DESKTOP_AUTH_SERVICE,
      useFactory: (database: PrismaClient, securityEvents: SecurityEventService) => new DesktopAuthService(
        database,
        auth,
        securityEvents,
        loadConfig().betterAuthSecret,
      ),
      inject: [PrismaClient, SECURITY_EVENT_SERVICE],
    },
    {
      provide: REGISTRATION_SERVICE,
      useFactory: (
        database: PrismaClient,
        identity: AuthService<typeof auth>,
        desktopAuth: DesktopAuthService,
        redemption: RedemptionService,
        audit: ReturnType<typeof createAuditService>,
      ) => new RegistrationService(database, identity, desktopAuth, redemption, audit, loadConfig().registrationMode),
      inject: [PrismaClient, AuthService, DESKTOP_AUTH_SERVICE, REDEMPTION_SERVICE, AUDIT_SERVICE],
    },
  ],
})
export class AppModule {}
