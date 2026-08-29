import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';
import { EntitlementService } from './entitlement.service.js';

export const ENTITLEMENT_SERVICE = 'ENTITLEMENT_SERVICE';

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
}
