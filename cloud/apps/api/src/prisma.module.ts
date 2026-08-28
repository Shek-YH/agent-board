import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { closeDatabase, prisma } from './database.js';

class PrismaLifecycle implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await closeDatabase();
  }
}

@Global()
@Module({
  providers: [
    { provide: PrismaClient, useValue: prisma },
    PrismaLifecycle,
  ],
  exports: [PrismaClient],
})
export class PrismaModule {}
