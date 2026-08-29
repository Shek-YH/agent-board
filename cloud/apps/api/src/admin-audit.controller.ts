import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';
import { createAuditService } from './audit.js';

export const AUDIT_SERVICE = 'AUDIT_SERVICE';

@UseGuards(AdminGuard)
@Controller('v1/admin/audit-logs')
export class AdminAuditController {
  constructor(@Inject(AUDIT_SERVICE) private readonly audit: ReturnType<typeof createAuditService>) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.audit.list(query);
  }
}
