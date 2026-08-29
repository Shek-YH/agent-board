-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ConcurrencyPolicy" AS ENUM ('REJECT', 'KICK_OLDEST');

-- CreateEnum
CREATE TYPE "EntitlementStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "EntitlementGrantType" AS ENUM ('DURATION', 'PERMANENT');

-- CreateEnum
CREATE TYPE "EntitlementGrantSource" AS ENUM ('REDEMPTION', 'ADMIN_GRANT', 'AGENT_GRANT', 'PROMOTION', 'COMPENSATION', 'MIGRATION');

-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationSeconds" INTEGER,
    "isPermanent" BOOLEAN NOT NULL DEFAULT false,
    "maxRegisteredDevices" INTEGER NOT NULL DEFAULT 1,
    "maxConcurrentDevices" INTEGER NOT NULL DEFAULT 1,
    "maxInstancesPerDevice" INTEGER NOT NULL DEFAULT 1,
    "heartbeatRequired" BOOLEAN NOT NULL DEFAULT true,
    "heartbeatIntervalSeconds" INTEGER NOT NULL DEFAULT 60,
    "leaseTtlSeconds" INTEGER NOT NULL DEFAULT 180,
    "offlineGraceSeconds" INTEGER NOT NULL DEFAULT 0,
    "deviceResetLimit" INTEGER NOT NULL DEFAULT 0,
    "deviceResetWindowDays" INTEGER NOT NULL DEFAULT 30,
    "concurrencyPolicy" "ConcurrencyPolicy" NOT NULL DEFAULT 'REJECT',
    "features" JSONB NOT NULL DEFAULT '{}',
    "agentCostCredits" INTEGER NOT NULL DEFAULT 0,
    "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "planId" TEXT,
    "status" "EntitlementStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "isPermanent" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_grant" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "type" "EntitlementGrantType" NOT NULL,
    "durationSeconds" INTEGER,
    "source" "EntitlementGrantSource" NOT NULL,
    "redemptionCodeId" TEXT,
    "operatorId" TEXT,
    "agentId" TEXT,
    "oldExpiresAt" TIMESTAMP(3),
    "newExpiresAt" TIMESTAMP(3),
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_code_key" ON "product"("code");

-- CreateIndex
CREATE UNIQUE INDEX "plan_productId_code_key" ON "plan"("productId", "code");

-- CreateIndex
CREATE INDEX "plan_productId_status_idx" ON "plan"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "entitlement_userId_productId_key" ON "entitlement"("userId", "productId");

-- CreateIndex
CREATE INDEX "entitlement_userId_status_idx" ON "entitlement"("userId", "status");

-- CreateIndex
CREATE INDEX "entitlement_expiresAt_status_idx" ON "entitlement"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "entitlement_grant_entitlementId_createdAt_idx" ON "entitlement_grant"("entitlementId", "createdAt");

-- CreateIndex
CREATE INDEX "entitlement_grant_requestId_idx" ON "entitlement_grant"("requestId");

-- AddForeignKey
ALTER TABLE "plan" ADD CONSTRAINT "plan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_grant" ADD CONSTRAINT "entitlement_grant_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
