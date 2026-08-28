'use strict';

async function ensureUserProfile(database, user) {
  if (!user?.id) return null;
  return database.userProfile.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id, role: 'USER', status: 'ACTIVE' },
    select: { userId: true, role: true, status: true },
  });
}

module.exports = { ensureUserProfile };
