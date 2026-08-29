import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';
import { ClientVersionPolicyService } from './version-policy.service.js';

export const VERSION_POLICY_SERVICE = 'VERSION_POLICY_SERVICE';

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
@Controller('v1/admin/version-policies')
export class AdminVersionPolicyController {
  constructor(@Inject(VERSION_POLICY_SERVICE) private readonly policies: ClientVersionPolicyService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.policies.list(query);
  }

  @Post()
  create(@Body() input: Record<string, unknown>, @Req() request: any) {
    return this.policies.create(input, auditContext(request));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.policies.getById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() changes: Record<string, unknown>, @Req() request: any) {
    return this.policies.update(id, changes, auditContext(request));
  }
}
