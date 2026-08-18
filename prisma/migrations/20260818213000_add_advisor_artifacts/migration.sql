CREATE TABLE "AdvisorArtifact" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvisorArtifact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdvisorArtifact_orgId_createdAt_idx" ON "AdvisorArtifact"("orgId", "createdAt");
CREATE INDEX "AdvisorArtifact_type_idx" ON "AdvisorArtifact"("type");

ALTER TABLE "AdvisorArtifact"
ADD CONSTRAINT "AdvisorArtifact_orgId_fkey"
FOREIGN KEY ("orgId") REFERENCES "Org"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
