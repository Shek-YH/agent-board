import { Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';
import { SecurityEventService } from './security-event.service.js';

export const SECURITY_EVENT_SERVICE = 'SECURITY_EVENT_SERVICE';

function context(request: any) {
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
@Controller('v1/admin/security-events')
export class SecurityEventController {
  constructor(@Inject(SECURITY_EVENT_SERVICE) private readonly events: SecurityEventService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.events.list(query);
  }

  @Post(':id/resolve')
  resolve(@Param('id') id: string, @Req() request: any) {
    return this.events.resolve(id, context(request));
  }
}
