-- Additive and safe when Railway's predeploy db push already added the column.
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "details" JSONB;
