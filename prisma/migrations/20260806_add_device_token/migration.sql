-- Device session token for paired tablets / driver app.
-- Issued on successful pairing claim (code + PIN), presented as
-- `Authorization: Bearer <token>` on subsequent device requests.
-- Only the SHA-256 hash is stored; the raw token is returned exactly once.
ALTER TABLE "Pairing" ADD COLUMN IF NOT EXISTS "deviceTokenHash" TEXT;
ALTER TABLE "Pairing" ADD COLUMN IF NOT EXISTS "deviceTokenIssuedAt" TIMESTAMP(3);

-- Safe on a fresh column: Postgres permits many NULLs in a unique index,
-- and every existing row has NULL here.
CREATE UNIQUE INDEX IF NOT EXISTS "Pairing_deviceTokenHash_key" ON "Pairing"("deviceTokenHash");
