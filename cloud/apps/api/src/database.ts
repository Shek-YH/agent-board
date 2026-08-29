import { PrismaClient } from '@prisma/client';

// One process-wide client is shared by Better Auth and Nest health checks.
export const prisma = new PrismaClient();

export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
}
