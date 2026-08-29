CREATE TYPE "SecurityEventSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "SecurityEventStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "security_event" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "agentId" TEXT,
    "type" TEXT NOT NULL,
    "severity" "SecurityEventSeverity" NOT NULL DEFAULT 'MEDIUM',
    "ip" TEXT,
    "metadataSanitized" JSONB NOT NULL DEFAULT '{}',
    "status" "SecurityEventStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "security_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "security_event_status_createdAt_idx" ON "security_event"("status", "createdAt");
CREATE INDEX "security_event_type_createdAt_idx" ON "security_event"("type", "createdAt");
CREATE INDEX "security_event_userId_createdAt_idx" ON "security_event"("userId", "createdAt");
CREATE INDEX "security_event_deviceId_createdAt_idx" ON "security_event"("deviceId", "createdAt");

ALTER TABLE "security_event" ADD CONSTRAINT "security_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "security_event" ADD CONSTRAINT "security_event_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "security_event" ADD CONSTRAINT "security_event_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "security_event" ADD CONSTRAINT "security_event_resolvedBy_fkey" FOREIGN KEY ("resolvedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
