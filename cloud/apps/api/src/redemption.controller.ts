import { Body, Controller, Post, Req } from '@nestjs/common';
import { Session, UserSession } from '@thallesp/nestjs-better-auth';

import { RedemptionService } from './redemption.service.js';
import { REDEMPTION_SERVICE } from './admin-redemption.controller.js';
import type { RateLimitService } from './rate-limit.service.js';
import { RATE_LIMIT_SERVICE } from './rate-limit.tokens.js';
import { Inject } from '@nestjs/common';

@Controller('v1/redemptions')
export class RedemptionController {
  constructor(
    @Inject(REDEMPTION_SERVICE) private readonly redemption: RedemptionService,
    @Inject(RATE_LIMIT_SERVICE) private readonly rateLimits: RateLimitService,
  ) {}

  @Post('redeem')
  redeem(@Session() session: UserSession, @Body() input: Record<string, unknown>, @Req() request: any) {
    this.rateLimits.consume({ route: 'redeem', ip: request.ip, userId: session.user.id, deviceId: input.deviceId });
    const requestId = request.get?.('idempotency-key') || input.requestId;
    return this.redemption.redeem(session.user.id, { ...input, requestId }, {
      actorType: 'USER',
      actorId: session.user.id,
      requestId: request.res?.locals?.requestId,
      ip: request.ip,
      userAgent: request.get?.('user-agent') || request.headers?.['user-agent'],
    });
  }
}
