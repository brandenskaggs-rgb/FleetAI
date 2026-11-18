CREATE TABLE "SensorWatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orgId" TEXT NOT NULL,
  "vehicleId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "groups" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "requestedBy" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "stoppedAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "supportedKeys" JSONB NOT NULL DEFAULT '[]',
  "deviceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "SensorWatch_orgId_vehicleId_key" ON "SensorWatch"("orgId", "vehicleId");
