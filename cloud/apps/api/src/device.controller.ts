import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { Session, UserSession } from '@thallesp/nestjs-better-auth';

import { DeviceService } from './device.service.js';
import type { RateLimitService } from './rate-limit.service.js';
import { RATE_LIMIT_SERVICE } from './rate-limit.tokens.js';

export const DEVICE_SERVICE = 'DEVICE_SERVICE';

function context(request: any) {
  return {
    actorType: 'USER',
    actorId: request.session?.user?.id,
    requestId: request.res?.locals?.requestId,
    ip: request.ip,
    userAgent: request.get?.('user-agent') || request.headers?.['user-agent'],
  };
}

@Controller('v1/devices')
export class DeviceController {
  constructor(
    @Inject(DEVICE_SERVICE) private readonly devices: DeviceService,
    @Inject(RATE_LIMIT_SERVICE) private readonly rateLimits: RateLimitService,
  ) {}

  @Post('enroll')
  enroll(@Session() session: UserSession, @Body() input: Record<string, unknown>, @Req() request: any) {
    this.rateLimits.consume({ route: 'device-enroll', ip: request.ip, userId: session.user.id, deviceId: input.installationId });
    return this.devices.enroll(session.user.id, input, context(request));
  }

  @Get('me')
  me(@Session() session: UserSession) {
    return this.devices.listMine(session.user.id);
  }

  @Post(':id/revoke')
  revoke(@Session() session: UserSession, @Param('id') id: string, @Req() request: any) {
    return this.devices.revoke(session.user.id, id, context(request));
  }
}
