import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { AGENT_SERVICE } from './agent.tokens.js';
import { AgentService } from './agent.service.js';

@Injectable()
export class AgentGuard implements CanActivate {
  constructor(@Inject(AGENT_SERVICE) private readonly agents: AgentService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const userId = request.session?.user?.id;
    if (!userId) throw new UnauthorizedException({ code: 'AUTH_REQUIRED' });
    const agent = await this.agents.getByUserId(userId);
    if (!agent) throw new ForbiddenException({ code: 'AGENT_REQUIRED' });
    if (agent.status !== 'ACTIVE') throw new ForbiddenException({ code: 'AGENT_NOT_ACTIVE' });
    request.agent = agent;
    return true;
  }
}
