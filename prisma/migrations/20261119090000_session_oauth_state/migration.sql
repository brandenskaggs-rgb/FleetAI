ALTER TABLE "Session"
ADD COLUMN "motiveOAuthStateHash" TEXT,
ADD COLUMN "motiveOAuthStateExpiresAt" TIMESTAMP(3);
