import { Body, Controller, Post, Req } from '@nestjs/common';
import { Session, UserSession } from '@thallesp/nestjs-better-auth';

import { RedemptionService } from './redemption.service.js';
import { REDEMPTION_SERVICE } from './admin-redemption.controller.js';
import { Inject } from '@nestjs/common';

@Controller('v1/redemptions')
export class RedemptionController {
  constructor(@Inject(REDEMPTION_SERVICE) private readonly redemption: RedemptionService) {}

  @Post('redeem')
  redeem(@Session() session: UserSession, @Body() input: Record<string, unknown>, @Req() request: any) {
    const requestId = request.get?.('idempotency-key') || input.requestId;
    return this.redemption.redeem(session.user.id, { ...input, requestId });
  }
}
