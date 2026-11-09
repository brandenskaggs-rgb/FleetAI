-- Additive: old feedback remains readable but lacks supervised outcome evidence.
ALTER TABLE "FeedbackLog" ADD COLUMN "sourceReference" TEXT;
ALTER TABLE "FeedbackLog" ADD COLUMN "outcomeEvidence" JSONB NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX "FeedbackLog_orgId_sourceReference_key" ON "FeedbackLog"("orgId", "sourceReference");
CREATE INDEX "FeedbackLog_orgId_createdAt_idx" ON "FeedbackLog"("orgId", "createdAt");
CREATE TABLE "MlLearningRun" (
  "id" TEXT PRIMARY KEY, "orgId" TEXT NOT NULL, "status" TEXT NOT NULL,
  "summary" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MlLearningRun_orgId_createdAt_idx" ON "MlLearningRun"("orgId", "createdAt");
