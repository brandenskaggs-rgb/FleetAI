ALTER TABLE "Alert" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Alert_dedupeKey_key" ON "Alert"("dedupeKey");
