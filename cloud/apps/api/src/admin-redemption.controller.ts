import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';
import { RedemptionService } from './redemption.service.js';

export const REDEMPTION_SERVICE = 'REDEMPTION_SERVICE';

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
@Controller('v1/admin/redemption-batches')
export class AdminRedemptionBatchesController {
  constructor(@Inject(REDEMPTION_SERVICE) private readonly redemption: RedemptionService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.redemption.listBatches(query);
  }

  @Post()
  create(@Body() input: Record<string, unknown>, @Req() request: any) {
    return this.redemption.createBatch(input, auditContext(request));
  }
}

@UseGuards(AdminGuard)
@Controller('v1/admin/redemption-codes')
export class AdminRedemptionCodesController {
  constructor(@Inject(REDEMPTION_SERVICE) private readonly redemption: RedemptionService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.redemption.listCodes(query);
  }

  @Post(':id/revoke')
  revoke(@Param('id') id: string, @Req() request: any) {
    return this.redemption.revokeCode(id, auditContext(request));
  }
}
