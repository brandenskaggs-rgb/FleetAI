ALTER TABLE "Alert" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;

CREATE INDEX IF NOT EXISTS "Alert_dedupeKey_idx" ON "Alert"("dedupeKey");
