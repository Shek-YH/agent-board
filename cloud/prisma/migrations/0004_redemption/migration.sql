-- CreateEnum
CREATE TYPE "RedemptionBatchStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RedemptionCodeStatus" AS ENUM ('UNUSED', 'REDEEMED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "redemption_batch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "ownerAgentId" TEXT,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" "RedemptionBatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "redemption_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redemption_code" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeLast4" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "durationSeconds" INTEGER,
    "status" "RedemptionCodeStatus" NOT NULL DEFAULT 'UNUSED',
    "ownerAgentId" TEXT,
    "createdBy" TEXT NOT NULL,
    "redeemedByUserId" TEXT,
    "redeemedAt" TIMESTAMP(3),
    "codeExpiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "redemption_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redemption_request" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redemption_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "redemption_batch_productId_createdAt_idx" ON "redemption_batch"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "redemption_batch_planId_status_idx" ON "redemption_batch"("planId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "redemption_code_codeHash_key" ON "redemption_code"("codeHash");

-- CreateIndex
CREATE INDEX "redemption_code_batchId_status_idx" ON "redemption_code"("batchId", "status");

-- CreateIndex
CREATE INDEX "redemption_code_planId_status_idx" ON "redemption_code"("planId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "redemption_request_requestId_key" ON "redemption_request"("requestId");

-- CreateIndex
CREATE INDEX "redemption_request_userId_createdAt_idx" ON "redemption_request"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "redemption_batch" ADD CONSTRAINT "redemption_batch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_batch" ADD CONSTRAINT "redemption_batch_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_code" ADD CONSTRAINT "redemption_code_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "redemption_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_code" ADD CONSTRAINT "redemption_code_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_request" ADD CONSTRAINT "redemption_request_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_request" ADD CONSTRAINT "redemption_request_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "redemption_code"("id") ON DELETE CASCADE ON UPDATE CASCADE;
