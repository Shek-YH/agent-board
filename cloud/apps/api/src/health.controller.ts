import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { PrismaClient } from '@prisma/client';

import { createHealthService } from './health.js';

@AllowAnonymous()
@Controller('health')
export class HealthController {
  private readonly health;

  constructor(@Inject(PrismaClient) database: PrismaClient) {
    this.health = createHealthService({
      checkDatabase: () => database.$queryRaw`SELECT 1`,
    });
  }

  @Get('live')
  live() {
    return this.health.live();
  }

  @Get('ready')
  async ready() {
    try {
      return await this.health.ready();
    } catch (error) {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        code: error instanceof Error && 'code' in error
          ? String(error.code)
          : 'DATABASE_UNAVAILABLE',
      });
    }
  }
}
