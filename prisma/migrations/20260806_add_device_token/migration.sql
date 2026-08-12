-- Device session token for paired tablets / driver app.
-- Issued on successful pairing claim (code + PIN), presented as
-- `Authorization: Bearer <token>` on subsequent device requests.
-- Only the SHA-256 hash is stored; the raw token is returned exactly once.
ALTER TABLE "Pairing" ADD COLUMN IF NOT EXISTS "deviceTokenHash" TEXT;
ALTER TABLE "Pairing" ADD COLUMN IF NOT EXISTS "deviceTokenIssuedAt" TIMESTAMP(3);

-- Plain index, not unique. The value is SHA-256 of 32 bytes of crypto
-- randomness, so uniqueness is guaranteed by the input space rather than by a
-- constraint. A unique constraint here also made `prisma db push` refuse to
-- deploy (it cannot prove safety against existing rows), which kept the P0 auth
-- fixes off production. Keep this index and the schema in agreement.
CREATE INDEX IF NOT EXISTS "Pairing_deviceTokenHash_idx" ON "Pairing"("deviceTokenHash");

-- If an earlier partial deploy created the unique variant, drop it so the
-- database matches the schema and db push has nothing to reconcile.
DROP INDEX IF EXISTS "Pairing_deviceTokenHash_key";
