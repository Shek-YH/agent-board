-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING', 'ACTIVE', 'STALE', 'REVOKED', 'BLOCKED');

-- CreateTable
CREATE TABLE "device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "fingerprintHash" TEXT,
    "fingerprintSignalsHash" JSONB,
    "fingerprintVersion" TEXT,
    "deviceName" TEXT,
    "os" TEXT,
    "osVersion" TEXT,
    "appVersion" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastIp" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING',
    "trustedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_userId_installationId_key" ON "device"("userId", "installationId");

CREATE INDEX "device_userId_status_idx" ON "device"("userId", "status");

CREATE INDEX "device_installationId_idx" ON "device"("installationId");

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
