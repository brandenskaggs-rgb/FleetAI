-- On-board diagnostic scans. One row per scan run, including clean scans
-- (evidence the truck was checked). Codes/summary stored already-decoded so
-- historical rows do not depend on the current catalog contents.
CREATE TABLE "DiagnosticScan" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "deviceId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'device',
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "driveability" TEXT NOT NULL DEFAULT 'ok',
    "codeCount" INTEGER NOT NULL DEFAULT 0,
    "codes" JSONB NOT NULL DEFAULT '[]',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiagnosticScan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiagnosticScan_vehicleId_scannedAt_idx" ON "DiagnosticScan"("vehicleId", "scannedAt");
CREATE INDEX "DiagnosticScan_orgId_severity_idx" ON "DiagnosticScan"("orgId", "severity");

ALTER TABLE "DiagnosticScan" ADD CONSTRAINT "DiagnosticScan_vehicleId_fkey"
    FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DiagnosticScan" ADD CONSTRAINT "DiagnosticScan_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;
