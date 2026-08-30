import { Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';
import { EntitlementService } from './entitlement.service.js';

export const ENTITLEMENT_SERVICE = 'ENTITLEMENT_SERVICE';

function auditContext(request: any) {
  return {
    actorType: 'USER',
    actorId: request.session?.user?.id,
    actorRole: request.adminProfile?.role,
    requestId: request.res?.locals?.requestId,
    ip: request.ip,
    userAgent: request.get?.('user-agent') || request.headers?.['user-agent'],
  };
}

@UseGuards(AdminGuard)
@Controller('v1/admin/entitlements')
export class AdminEntitlementsController {
  constructor(@Inject(ENTITLEMENT_SERVICE) private readonly entitlements: EntitlementService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.entitlements.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.entitlements.getById(id);
  }

  @Post(':id/suspend')
  suspend(@Param('id') id: string, @Req() request: any) {
    return this.entitlements.setStatus(id, 'SUSPENDED', auditContext(request));
  }

  @Post(':id/revoke')
  revoke(@Param('id') id: string, @Req() request: any) {
    return this.entitlements.setStatus(id, 'REVOKED', auditContext(request));
  }

  @Post(':id/enable')
  enable(@Param('id') id: string, @Req() request: any) {
    return this.entitlements.setStatus(id, 'ACTIVE', auditContext(request));
  }
}
