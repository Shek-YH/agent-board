import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { Session, UserSession } from '@thallesp/nestjs-better-auth';

import { LeaseService } from './lease.service.js';
import type { RateLimitService } from './rate-limit.service.js';
import { RATE_LIMIT_SERVICE } from './rate-limit.tokens.js';

export const LEASE_SERVICE = 'LEASE_SERVICE';

function context(request: any) {
  return {
    actorType: 'USER',
    actorId: request.session?.user?.id,
    requestId: request.res?.locals?.requestId,
    ip: request.ip,
    userAgent: request.get?.('user-agent') || request.headers?.['user-agent'],
  };
}
@Controller('v1/license')
export class LicenseController {
  constructor(
    @Inject(LEASE_SERVICE) private readonly leases: LeaseService,
    @Inject(RATE_LIMIT_SERVICE) private readonly rateLimits: RateLimitService,
  ) {}

  @Get('status')
  status(@Session() session: UserSession, @Req() request: any) {
    return this.leases.getStatus(session.user.id, request.query || {});
  }

  @Post('acquire')
  acquire(@Session() session: UserSession, @Body() input: Record<string, unknown>, @Req() request: any) {
    this.rateLimits.consume({ route: 'acquire', ip: request.ip, userId: session.user.id, deviceId: input.deviceId });
    return this.leases.acquire(session.user.id, input, context(request));
  }

  @Post('heartbeat')
  heartbeat(@Session() session: UserSession, @Body() input: Record<string, unknown>, @Req() request: any) {
    this.rateLimits.consume({ route: 'heartbeat', ip: request.ip, userId: session.user.id, deviceId: input.deviceId });
    return this.leases.heartbeat(session.user.id, input, context(request));
  }

  @Post('release')
  release(@Session() session: UserSession, @Body() input: Record<string, unknown>, @Req() request: any) {
    return this.leases.release(session.user.id, String(input.leaseId || ''), context(request));
  }
}
