-- Device session token for paired tablets / driver app.
-- Issued on successful pairing claim (code + PIN), presented as
-- `Authorization: Bearer <token>` on subsequent device requests.
-- Only the SHA-256 hash is stored; the raw token is returned exactly once.
ALTER TABLE "Pairing" ADD COLUMN "deviceTokenHash" TEXT;
ALTER TABLE "Pairing" ADD COLUMN "deviceTokenIssuedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Pairing_deviceTokenHash_key" ON "Pairing"("deviceTokenHash");
