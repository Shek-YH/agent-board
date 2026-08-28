import { PrismaClient } from '@prisma/client';

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const role = (process.env.BOOTSTRAP_ADMIN_ROLE || 'ADMIN').trim().toUpperCase();
const allowedRoles = new Set(['SUPER_ADMIN', 'ADMIN']);

if (!email || !allowedRoles.has(role)) {
  console.error('Set BOOTSTRAP_ADMIN_EMAIL and optional BOOTSTRAP_ADMIN_ROLE=ADMIN|SUPER_ADMIN');
  process.exit(1);
}

const database = new PrismaClient();
try {
  const user = await database.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) {
    console.error('User not found for the supplied email');
    process.exitCode = 1;
  } else {
    await database.userProfile.upsert({
      where: { userId: user.id },
      update: { role, status: 'ACTIVE' },
      create: { userId: user.id, role, status: 'ACTIVE' },
    });
    console.log(`Promoted ${user.email} to ${role}`);
  }
} finally {
  await database.$disconnect();
}
