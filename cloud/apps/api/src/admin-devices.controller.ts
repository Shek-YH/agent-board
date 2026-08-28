import { Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';
import { DeviceService } from './device.service.js';
import { DEVICE_SERVICE } from './device.controller.js';

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
@Controller('v1/admin/devices')
export class AdminDevicesController {
  constructor(@Inject(DEVICE_SERVICE) private readonly devices: DeviceService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.devices.listAll(query);
  }

  @Post(':id/revoke')
  revoke(@Param('id') id: string, @Req() request: any) {
    return this.devices.adminRevoke(id, auditContext(request));
  }
}
