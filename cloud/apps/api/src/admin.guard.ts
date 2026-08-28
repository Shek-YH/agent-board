import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { canAccessAdmin } from './authorization.js';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(PrismaClient) private readonly database: PrismaClient) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const userId = request.session?.user?.id;
    if (!userId) throw new UnauthorizedException({ code: 'AUTH_REQUIRED' });

    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { role: true, status: true },
    });
    if (!canAccessAdmin(profile)) {
      throw new ForbiddenException({ code: 'ADMIN_REQUIRED' });
    }

    request.adminProfile = profile;
    return true;
  }
}
