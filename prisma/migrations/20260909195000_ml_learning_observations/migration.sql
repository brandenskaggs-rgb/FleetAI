-- Per-tenant, versioned contributions make delayed uploads and retries idempotent.
CREATE TABLE "MlLearningObservation" (
  "orgId" TEXT NOT NULL,
  "vehicleId" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "bucketAt" TIMESTAMP(3) NOT NULL,
  "observations" JSONB NOT NULL,
  CONSTRAINT "MlLearningObservation_pkey" PRIMARY KEY ("orgId", "vehicleId", "schemaVersion", "bucketAt")
);
CREATE INDEX "TelemetrySample_vehicleId_orgId_createdAt_id_idx"
  ON "TelemetrySample"("vehicleId", "orgId", "createdAt", "id");
