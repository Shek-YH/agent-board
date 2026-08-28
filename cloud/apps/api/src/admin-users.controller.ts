import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';
import { AdminUsersService } from './admin-users.service.js';

export const ADMIN_USERS_SERVICE = 'ADMIN_USERS_SERVICE';

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
@Controller('v1/admin/users')
export class AdminUsersController {
  constructor(@Inject(ADMIN_USERS_SERVICE) private readonly users: AdminUsersService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.users.list(query);
  }

  @Post()
  create(@Body() input: Record<string, unknown>, @Req() request: any) {
    return this.users.create(input, auditContext(request));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.users.getById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() changes: Record<string, unknown>, @Req() request: any) {
    return this.users.update(id, changes, auditContext(request));
  }

  @Post(':id/disable')
  disable(@Param('id') id: string, @Req() request: any) {
    return this.users.setStatus(id, 'DISABLED', auditContext(request));
  }

  @Post(':id/enable')
  enable(@Param('id') id: string, @Req() request: any) {
    return this.users.setStatus(id, 'ACTIVE', auditContext(request));
  }
}
