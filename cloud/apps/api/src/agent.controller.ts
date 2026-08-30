import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { AgentGuard } from './agent.guard.js';
import { AgentService } from './agent.service.js';
import { AGENT_SERVICE } from './agent.tokens.js';
import { PrismaClient } from '@prisma/client';
import { EntitlementService } from './entitlement.service.js';
import { ENTITLEMENT_SERVICE } from './admin-entitlements.controller.js';
import { RedemptionService } from './redemption.service.js';
import { REDEMPTION_SERVICE } from './admin-redemption.controller.js';

function context(request: any) {
  return {
    actorType: 'AGENT',
    actorId: request.session?.user?.id,
    agentId: request.agent?.id,
    requestId: request.res?.locals?.requestId,
    ip: request.ip,
    userAgent: request.get?.('user-agent') || request.headers?.['user-agent'],
  };
}

@UseGuards(AgentGuard)
@Controller('v1/agent')
export class AgentController {
  constructor(
    @Inject(AGENT_SERVICE) private readonly agents: AgentService,
    @Inject(REDEMPTION_SERVICE) private readonly redemption: RedemptionService,
    @Inject(ENTITLEMENT_SERVICE) private readonly entitlements: EntitlementService,
    @Inject(PrismaClient) private readonly database: PrismaClient,
  ) {}

  @Get('me')
  async me(@Req() request: any) {
    const agentId = request.agent.id;
    const scopeIds = await this.agents.getScopeIds(agentId);
    const [agent, ledger, users, codes] = await Promise.all([
      this.agents.getById(agentId),
      this.agents.getBalance(agentId),
      this.database.userProfile.count({ where: { agentId: { in: scopeIds } } }),
      this.redemption.listCodes({ ownerAgentIds: scopeIds, status: 'UNUSED' }),
    ]);
    const subAgents = await this.agents.list({ parentAgentId: agentId });
    return {
      agent,
      balance: ledger,
      subAgentCount: subAgents.items.length,
      userCount: users,
      unusedCodeCount: codes.items.length,
    };
  }

  @Get('profile')
  profile(@Req() request: any) {
    return this.agents.getById(request.agent.id);
  }

  @Get('batches')
  async batches(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.redemption.listBatches({ ...query, ownerAgentIds: await this.agents.getScopeIds(request.agent.id) });
  }

  @Post('batches')
  createBatch(@Body() input: Record<string, unknown>, @Req() request: any) {
    return this.redemption.createBatch({ ...input, ownerAgentId: request.agent.id }, context(request));
  }

  @Get('codes')
  async codes(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.redemption.listCodes({ ...query, ownerAgentIds: await this.agents.getScopeIds(request.agent.id) });
  }

  @Get('users')
  async users(@Req() request: any) {
    const scopeIds = await this.agents.getScopeIds(request.agent.id);
    const profiles = await this.database.userProfile.findMany({
      where: { agentId: { in: scopeIds } },
      select: { userId: true, role: true, status: true, agentId: true, user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { items: profiles.map((profile) => ({ id: profile.userId, name: profile.user.name, email: profile.user.email, role: profile.role, status: profile.status, agentId: profile.agentId })) };
  }

  @Get('sub-agents')
  subAgents(@Req() request: any) {
    return this.agents.list({ parentAgentId: request.agent.id });
  }

  @Post('sub-agents')
  createSubAgent(@Body() input: Record<string, unknown>, @Req() request: any) {
    return this.agents.create({ ...input, parentAgentId: request.agent.id }, context(request));
  }

  @Get('ledger')
  ledger(@Query() query: Record<string, unknown>, @Req() request: any) {
    return this.agents.listLedger(request.agent.id, query);
  }

  @Post('users/:id/grants')
  async grant(@Param('id') userId: string, @Body() input: Record<string, unknown>, @Req() request: any) {
    const profile = await this.database.userProfile.findUnique({ where: { userId }, select: { agentId: true } });
    if (!profile?.agentId) throw new ForbiddenException({ code: 'AGENT_USER_NOT_IN_SCOPE' });
    await this.agents.assertInScope(request.agent.id, profile.agentId);
    return this.entitlements.grantToUser(userId, input, { ...context(request), source: 'AGENT_GRANT' });
  }
}
