-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "AgentLedgerEntryType" AS ENUM ('CREDIT', 'DEBIT', 'REFUND', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentAgentId" TEXT,
    "level" INTEGER NOT NULL DEFAULT 1,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "canCreateSubAgents" BOOLEAN NOT NULL DEFAULT false,
    "maxSubAgentDepth" INTEGER,
    "planAllowlist" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_ledger_entry" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "AgentLedgerEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "relatedBatchId" TEXT,
    "relatedCodeId" TEXT,
    "operatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_userId_key" ON "agent"("userId");

-- CreateIndex
CREATE INDEX "agent_parentAgentId_idx" ON "agent"("parentAgentId");

-- CreateIndex
CREATE INDEX "agent_status_idx" ON "agent"("status");

-- CreateIndex
CREATE INDEX "agent_ledger_entry_agentId_createdAt_idx" ON "agent_ledger_entry"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_ledger_entry_relatedBatchId_idx" ON "agent_ledger_entry"("relatedBatchId");

-- CreateIndex
CREATE INDEX "agent_ledger_entry_relatedCodeId_idx" ON "agent_ledger_entry"("relatedCodeId");

-- A user can belong to one agent's data scope. Existing users remain unassigned.
ALTER TABLE "user_profile" ADD COLUMN "agentId" TEXT;

CREATE INDEX "user_profile_agentId_idx" ON "user_profile"("agentId");

-- AddForeignKey
ALTER TABLE "agent" ADD CONSTRAINT "agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent" ADD CONSTRAINT "agent_parentAgentId_fkey" FOREIGN KEY ("parentAgentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ledger_entry" ADD CONSTRAINT "agent_ledger_entry_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
