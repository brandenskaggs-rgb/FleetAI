ALTER TABLE "Driver"
ADD COLUMN "licenseState" TEXT,
ADD COLUMN "eldUsername" TEXT,
ADD COLUMN "eldExempt" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "Driver_orgId_eldUsername_key" ON "Driver"("orgId", "eldUsername");

CREATE TABLE "EldCarrierConfig" (
  "orgId" TEXT NOT NULL,
  "carrierName" TEXT NOT NULL,
  "usdotNumber" TEXT NOT NULL,
  "homeTerminalName" TEXT NOT NULL,
  "homeTerminalAddress" TEXT NOT NULL,
  "homeTerminalTimeZone" TEXT NOT NULL,
  "dayStartMinutes" INTEGER NOT NULL DEFAULT 0,
  "multidayBasis" TEXT NOT NULL DEFAULT 'US_70_8',
  "hosRuleProfile" TEXT NOT NULL DEFAULT 'FEDERAL_PROPERTY_70_8',
  "personalConveyance" BOOLEAN NOT NULL DEFAULT false,
  "yardMove" BOOLEAN NOT NULL DEFAULT false,
  "eldIdentifier" TEXT NOT NULL DEFAULT '',
  "eldRegistrationId" TEXT NOT NULL DEFAULT '',
  "eldProvider" TEXT NOT NULL DEFAULT 'Fleet AI',
  "certifiedSoftwareVersion" TEXT NOT NULL DEFAULT '',
  "certificationState" TEXT NOT NULL DEFAULT 'DEVELOPMENT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EldCarrierConfig_pkey" PRIMARY KEY ("orgId")
);

CREATE INDEX "EldCarrierConfig_certificationState_idx" ON "EldCarrierConfig"("certificationState");

CREATE TABLE "EldDeviceState" (
  "deviceId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "vehicleId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "sequenceCounter" INTEGER NOT NULL DEFAULT 0,
  "sequenceEpoch" INTEGER NOT NULL DEFAULT 0,
  "currentDriverId" TEXT,
  "currentDutyCode" INTEGER,
  "specialDrivingCode" INTEGER,
  "ignitionOn" BOOLEAN NOT NULL DEFAULT false,
  "vehicleMoving" BOOLEAN NOT NULL DEFAULT false,
  "motionStartedAt" TIMESTAMP(3),
  "stoppedAt" TIMESTAMP(3),
  "powerCycleStartedAt" TIMESTAMP(3),
  "powerCycleStartMiles" INTEGER,
  "powerCycleStartEngineHours" DECIMAL(7,1),
  "lastEngineSyncAt" TIMESTAMP(3),
  "lastPositionAt" TIMESTAMP(3),
  "lastTelemetryAt" TIMESTAMP(3),
  "engineSyncLossMs" BIGINT NOT NULL DEFAULT 0,
  "positioningLossMotionMs" BIGINT NOT NULL DEFAULT 0,
  "powerLossMotionMs" BIGINT NOT NULL DEFAULT 0,
  "lastRecordAt" TIMESTAMP(3),
  "lastIntermediateAt" TIMESTAMP(3),
  "lastTransferCheckAt" TIMESTAMP(3),
  "consecutiveTransferCheckFails" INTEGER NOT NULL DEFAULT 0,
  "unidentifiedDrivingMinutes" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EldDeviceState_pkey" PRIMARY KEY ("deviceId")
);

CREATE INDEX "EldDeviceState_orgId_vehicleId_idx" ON "EldDeviceState"("orgId", "vehicleId");
CREATE INDEX "EldDeviceState_enabled_idx" ON "EldDeviceState"("enabled");

CREATE TABLE "EldEvent" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "vehicleId" TEXT NOT NULL,
  "driverId" TEXT,
  "deviceId" TEXT NOT NULL,
  "sequenceId" INTEGER NOT NULL,
  "sequenceEpoch" INTEGER NOT NULL DEFAULT 0,
  "recordStatus" INTEGER NOT NULL DEFAULT 1,
  "recordOrigin" INTEGER NOT NULL,
  "eventType" INTEGER NOT NULL,
  "eventCode" INTEGER NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "eventDate" TEXT NOT NULL,
  "eventTime" TEXT NOT NULL,
  "timezoneOffsetMinutes" INTEGER NOT NULL,
  "accumulatedVehicleMiles" INTEGER,
  "elapsedEngineHours" DECIMAL(7,1),
  "totalVehicleMiles" INTEGER,
  "totalEngineHours" DECIMAL(7,1),
  "latitude" DECIMAL(7,2),
  "longitude" DECIMAL(8,2),
  "latitudeCode" TEXT NOT NULL DEFAULT 'X',
  "longitudeCode" TEXT NOT NULL DEFAULT 'X',
  "distanceSinceCoordinatesKm" INTEGER,
  "locationDescription" TEXT NOT NULL DEFAULT '',
  "annotation" TEXT NOT NULL DEFAULT '',
  "eldUsername" TEXT NOT NULL DEFAULT '',
  "cmvPowerUnitNumber" TEXT NOT NULL,
  "cmvVin" TEXT NOT NULL DEFAULT '',
  "trailerNumbers" TEXT NOT NULL DEFAULT '',
  "shippingDocumentNumber" TEXT NOT NULL DEFAULT '',
  "malfunctionIndicator" BOOLEAN NOT NULL DEFAULT false,
  "diagnosticIndicator" BOOLEAN NOT NULL DEFAULT false,
  "malfunctionDiagnosticCode" TEXT NOT NULL DEFAULT '',
  "eventDataCheck" TEXT NOT NULL,
  "relatedEventId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EldEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EldEvent_deviceId_sequenceEpoch_sequenceId_key" ON "EldEvent"("deviceId", "sequenceEpoch", "sequenceId");
CREATE INDEX "EldEvent_orgId_driverId_occurredAt_idx" ON "EldEvent"("orgId", "driverId", "occurredAt");
CREATE INDEX "EldEvent_vehicleId_occurredAt_idx" ON "EldEvent"("vehicleId", "occurredAt");
CREATE INDEX "EldEvent_deviceId_occurredAt_idx" ON "EldEvent"("deviceId", "occurredAt");
CREATE INDEX "EldEvent_recordStatus_eventType_idx" ON "EldEvent"("recordStatus", "eventType");
CREATE INDEX "EldEvent_relatedEventId_idx" ON "EldEvent"("relatedEventId");

CREATE TABLE "EldRecordCertification" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "driverId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "recordDate" TEXT NOT NULL,
  "certificationNumber" INTEGER NOT NULL,
  "eventId" TEXT NOT NULL,
  "certifiedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EldRecordCertification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EldRecordCertification_driverId_recordDate_certificationNumber_key" ON "EldRecordCertification"("driverId", "recordDate", "certificationNumber");
CREATE INDEX "EldRecordCertification_orgId_recordDate_idx" ON "EldRecordCertification"("orgId", "recordDate");

CREATE TABLE "EldEditProposal" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "driverId" TEXT NOT NULL,
  "originalEventId" TEXT NOT NULL,
  "proposedEventId" TEXT NOT NULL,
  "proposedByUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "annotation" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EldEditProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EldEditProposal_driverId_status_idx" ON "EldEditProposal"("driverId", "status");
CREATE INDEX "EldEditProposal_orgId_createdAt_idx" ON "EldEditProposal"("orgId", "createdAt");

CREATE TABLE "EldDiagnostic" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "vehicleId" TEXT NOT NULL,
  "driverId" TEXT,
  "deviceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DETECTED',
  "detectedAt" TIMESTAMP(3) NOT NULL,
  "clearedAt" TIMESTAMP(3),
  "eventId" TEXT,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EldDiagnostic_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EldDiagnostic_deviceId_status_code_idx" ON "EldDiagnostic"("deviceId", "status", "code");
CREATE INDEX "EldDiagnostic_orgId_detectedAt_idx" ON "EldDiagnostic"("orgId", "detectedAt");

CREATE TABLE "EldTransferAttempt" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "driverId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "outputFileName" TEXT NOT NULL,
  "outputFileComment" TEXT NOT NULL DEFAULT '',
  "fileDataCheck" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'GENERATED',
  "responseCode" TEXT,
  "responseDetail" JSONB NOT NULL DEFAULT '{}',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "EldTransferAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EldTransferAttempt_orgId_requestedAt_idx" ON "EldTransferAttempt"("orgId", "requestedAt");
CREATE INDEX "EldTransferAttempt_deviceId_status_idx" ON "EldTransferAttempt"("deviceId", "status");
