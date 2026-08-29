-- CreateEnum
CREATE TYPE "LicenseLeaseStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "license_lease" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "LicenseLeaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
    "lastIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "license_lease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "license_lease_userId_status_expiresAt_idx" ON "license_lease"("userId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "license_lease_deviceId_status_expiresAt_idx" ON "license_lease"("deviceId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "license_lease_sessionId_idx" ON "license_lease"("sessionId");

-- AddForeignKey
ALTER TABLE "license_lease" ADD CONSTRAINT "license_lease_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_lease" ADD CONSTRAINT "license_lease_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_lease" ADD CONSTRAINT "license_lease_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
