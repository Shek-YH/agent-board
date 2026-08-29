-- CreateEnum
CREATE TYPE "ClientVersionPolicyStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "client_version_policy" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "latestVersion" TEXT NOT NULL,
    "minimumVersion" TEXT NOT NULL,
    "forceUpgradeBelow" TEXT,
    "downloadUrl" TEXT,
    "message" TEXT,
    "status" "ClientVersionPolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_version_policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_version_policy_productId_key" ON "client_version_policy"("productId");

-- CreateIndex
CREATE INDEX "client_version_policy_productId_status_idx" ON "client_version_policy"("productId", "status");

-- AddForeignKey
ALTER TABLE "client_version_policy" ADD CONSTRAINT "client_version_policy_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
