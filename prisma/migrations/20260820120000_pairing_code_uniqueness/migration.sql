-- Pairing claims resolve by code alone, so two rows must never share a code.
-- Codes are generated with cryptographic randomness and retried on P2002.
CREATE UNIQUE INDEX "Pairing_pairCode_key" ON "Pairing"("pairCode");
