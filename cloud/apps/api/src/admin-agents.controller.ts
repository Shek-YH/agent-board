import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard.js';
import { AgentService } from './agent.service.js';
import { AGENT_SERVICE } from './agent.tokens.js';

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
@Controller('v1/admin/agents')
export class AdminAgentsController {
  constructor(@Inject(AGENT_SERVICE) private readonly agents: AgentService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.agents.list(query);
  }

  @Post()
  create(@Body() input: Record<string, unknown>, @Req() request: any) {
    return this.agents.create(input, auditContext(request));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.agents.getById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() changes: Record<string, unknown>, @Req() request: any) {
    return this.agents.update(id, changes, auditContext(request));
  }

  @Post(':id/ledger-adjustment')
  adjustLedger(@Param('id') id: string, @Body() input: Record<string, unknown>, @Req() request: any) {
    return this.agents.adjustLedger(id, input, auditContext(request));
  }

  @Post(':id/users/:userId')
  assignUser(@Param('id') id: string, @Param('userId') userId: string, @Req() request: any) {
    return this.agents.assignUser(id, userId, auditContext(request));
  }
}
