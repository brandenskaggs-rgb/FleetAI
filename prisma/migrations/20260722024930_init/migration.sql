-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'customer',
    "orgId" TEXT,
    "passwordHash" TEXT NOT NULL DEFAULT '',
    "passwordAlgo" TEXT NOT NULL DEFAULT 'bcrypt',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "mustSetPassword" BOOLEAN NOT NULL DEFAULT false,
    "requirePasswordReset" BOOLEAN NOT NULL DEFAULT false,
    "firstLogin" BOOLEAN NOT NULL DEFAULT false,
    "firstLoginRequired" BOOLEAN NOT NULL DEFAULT false,
    "mustResetPassword" BOOLEAN NOT NULL DEFAULT false,
    "isTemporaryPassword" BOOLEAN NOT NULL DEFAULT false,
    "setupTokenHash" TEXT,
    "setupTokenExpiresAt" BIGINT,
    "passwordLastSetAt" TIMESTAMP(3),
    "lastPasswordChangeAt" TIMESTAMP(3),
    "displayName" TEXT NOT NULL DEFAULT '',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "loginRole" TEXT NOT NULL,
    "orgId" TEXT,
    "displayName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'LEAD',
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "industry" TEXT,
    "companyCode" TEXT,
    "vehicleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL DEFAULT 'Fleet AI',
    "logoUrl" TEXT NOT NULL DEFAULT '',
    "themeMode" TEXT NOT NULL DEFAULT 'blue',
    "accentColor" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "TenantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgBillingSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'PILOT_CORE',
    "priceMonthly" DECIMAL(10,2) NOT NULL DEFAULT 59,
    "status" TEXT NOT NULL DEFAULT 'NONE',
    "activatedAt" TIMESTAMP(3),
    "nextBillAt" TIMESTAMP(3),
    "vehicleCount" INTEGER NOT NULL DEFAULT 0,
    "contractTermMonths" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgBillingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CARD_STUB',
    "billingName" TEXT NOT NULL DEFAULT '',
    "billingEmail" TEXT NOT NULL DEFAULT '',
    "last4" TEXT NOT NULL DEFAULT '',
    "expMonth" INTEGER NOT NULL DEFAULT 1,
    "expYear" INTEGER NOT NULL DEFAULT 2026,
    "brand" TEXT NOT NULL DEFAULT '',
    "postalCode" TEXT NOT NULL DEFAULT '',
    "accountType" TEXT NOT NULL DEFAULT '',
    "routingLast4" TEXT NOT NULL DEFAULT '',
    "accountLast4" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetAddon" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabledAddons" JSONB NOT NULL DEFAULT '{}',
    "trailerCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetAddon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "unitName" TEXT NOT NULL,
    "vin" TEXT,
    "type" TEXT,
    "orgId" TEXT,
    "year" INTEGER,
    "make" TEXT,
    "model" TEXT,
    "motiveId" TEXT,
    "motiveMetadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "pin" TEXT,
    "orgId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "licenseNum" TEXT,
    "motiveId" TEXT,
    "motiveMetadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pairing" (
    "id" TEXT NOT NULL,
    "pairCode" TEXT,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "deviceId" TEXT,
    "deviceLabel" TEXT,
    "driverPin" TEXT,
    "orgId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pairing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetrySample" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "ts" TIMESTAMP(3) NOT NULL,
    "odometer" DECIMAL(12,3),
    "engineHours" DECIMAL(10,2),
    "metrics" JSONB NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetrySample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetrySnapshot" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "deviceId" TEXT,
    "ts" TIMESTAMP(3) NOT NULL,
    "odometerMiles" DECIMAL(12,3),
    "engineHours" DECIMAL(10,2),
    "dtcCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rawPids" JSONB NOT NULL DEFAULT '{}',
    "derivedMetrics" JSONB NOT NULL DEFAULT '{}',
    "coolantTemp" DECIMAL(8,3),
    "batteryVoltage" DECIMAL(6,3),
    "engineLoad" DECIMAL(6,3),
    "maf" DECIMAL(8,3),
    "rpm" DECIMAL(8,2),
    "stft1" DECIMAL(6,3),
    "ltft1" DECIMAL(6,3),
    "intakeAirTemp" DECIMAL(8,3),
    "speedKph" DECIMAL(7,3),
    "fuelLevelPct" DECIMAL(6,3),
    "sourceProtocol" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "vin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetrySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryRecord" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'derived',
    "identifier" TEXT NOT NULL,
    "name" TEXT,
    "rawValue" DECIMAL(14,4),
    "normalizedValue" DECIMAL(14,4),
    "unit" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'ecu',
    "validity" TEXT NOT NULL DEFAULT 'ok',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelemetryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelState" (
    "vehicleId" TEXT NOT NULL,
    "orgId" TEXT,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelState_pkey" PRIMARY KEY ("vehicleId")
);

-- CreateTable
CREATE TABLE "MlModelArtifact" (
    "id" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "trainingSource" TEXT,
    "modelName" TEXT,
    "metadata" JSONB NOT NULL,
    "artifactPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlModelArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlBaselineProfile" (
    "profileKey" TEXT NOT NULL,
    "vehicleClass" TEXT,
    "make" TEXT,
    "model" TEXT,
    "protocol" TEXT,
    "powertrain" TEXT,
    "trainingSource" TEXT,
    "modelVersion" TEXT,
    "profileJson" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlBaselineProfile_pkey" PRIMARY KEY ("profileKey")
);

-- CreateTable
CREATE TABLE "MlPredictionRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "modelVersion" TEXT,
    "source" TEXT NOT NULL,
    "confidenceStage" TEXT,
    "confidence" DECIMAL(6,4),
    "riskProbability" DECIMAL(6,4),
    "healthScore" DECIMAL(6,2),
    "predictionJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlPredictionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlFeatureSnapshot" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "predictionRunId" TEXT,
    "featureJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlFeatureSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Baseline" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "mean" DECIMAL(14,6),
    "stdDev" DECIMAL(14,6),
    "min" DECIMAL(14,6),
    "max" DECIMAL(14,6),
    "p10" DECIMAL(14,6),
    "p50" DECIMAL(14,6),
    "p90" DECIMAL(14,6),
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "lastComputedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Baseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendSignal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "severity" TEXT,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrendSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerWebhook" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "partner" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "threshold" DECIMAL(4,2) NOT NULL DEFAULT 0.35,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "secret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "predictionRunId" TEXT,
    "outcome" TEXT NOT NULL,
    "notes" TEXT,
    "stage1Score" DECIMAL(6,4),
    "stage2Score" DECIMAL(6,4),
    "signalAgreement" DECIMAL(6,4),
    "features" JSONB NOT NULL DEFAULT '{}',
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatternSignature" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "maintenanceType" TEXT NOT NULL,
    "preWindowDays" INTEGER NOT NULL,
    "metricKey" TEXT NOT NULL,
    "signature" JSONB NOT NULL,
    "observedCount" INTEGER NOT NULL DEFAULT 1,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatternSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "severity" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "explanation" TEXT,
    "recommendedChecks" JSONB NOT NULL DEFAULT '[]',
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "dedupeKey" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastNotifiedAt" TIMESTAMP(3),
    "metricsSnapshot" JSONB NOT NULL DEFAULT '{}',
    "explanation" TEXT NOT NULL DEFAULT '',
    "recommendedActions" JSONB NOT NULL DEFAULT '[]',
    "explanationSource" TEXT NOT NULL DEFAULT 'fallback',

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT,
    "eventId" TEXT,
    "recipientType" TEXT,
    "recipientId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unread',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleCapability" (
    "vehicleId" TEXT NOT NULL,
    "vin" TEXT,
    "year" INTEGER,
    "make" TEXT,
    "modelYearStr" TEXT,
    "supportedSensors" JSONB NOT NULL DEFAULT '[]',
    "addonEligible" BOOLEAN NOT NULL DEFAULT false,
    "addonSensors" JSONB NOT NULL DEFAULT '[]',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleCapability_pkey" PRIMARY KEY ("vehicleId")
);

-- CreateTable
CREATE TABLE "AiReport" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "predictionSnapshot" JSONB NOT NULL,
    "modelUsed" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "tsStart" TIMESTAMP(3),
    "tsEnd" TIMESTAMP(3),
    "fuelLevelBefore" DECIMAL(6,2),
    "fuelLevelAfter" DECIMAL(6,2),
    "gallonsEstimated" DECIMAL(6,2),
    "detectedBy" TEXT NOT NULL DEFAULT 'AUTO',
    "confidence" DECIMAL(4,3),
    "note" TEXT,
    "deltaFuelPct" DECIMAL(6,2),
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FuelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "performedById" TEXT,
    "serviceType" TEXT,
    "serviceCategory" TEXT,
    "maintenanceType" TEXT,
    "description" TEXT,
    "performedAt" TIMESTAMP(3),
    "serviceDate" TIMESTAMP(3),
    "odometerMiles" DECIMAL(10,2),
    "engineHours" DECIMAL(10,2),
    "laborHours" DECIMAL(6,2),
    "laborCost" DECIMAL(10,2),
    "partsCost" DECIMAL(10,2),
    "totalCost" DECIMAL(10,2),
    "parts" JSONB NOT NULL DEFAULT '[]',
    "technicianName" TEXT,
    "shopName" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "dueDate" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderLine" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(8,2),
    "unitCost" DECIMAL(10,2),
    "totalCost" DECIMAL(10,2),
    "partNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "company" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "source" TEXT,
    "vehicleCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "email" TEXT,
    "type" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "userId" TEXT,
    "event" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "partnerName" TEXT NOT NULL,
    "orgId" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'standard',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_orgId_idx" ON "User"("orgId");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Org_status_idx" ON "Org"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSettings_orgId_key" ON "TenantSettings"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgBillingSettings_orgId_key" ON "OrgBillingSettings"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_orgId_key" ON "PaymentMethod"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "FleetAddon_orgId_key" ON "FleetAddon"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_vehicleId_key" ON "Vehicle"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_motiveId_key" ON "Vehicle"("motiveId");

-- CreateIndex
CREATE INDEX "Vehicle_orgId_idx" ON "Vehicle"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_driverId_key" ON "Driver"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_motiveId_key" ON "Driver"("motiveId");

-- CreateIndex
CREATE INDEX "Driver_orgId_idx" ON "Driver"("orgId");

-- CreateIndex
CREATE INDEX "Pairing_vehicleId_status_idx" ON "Pairing"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "Pairing_pairCode_idx" ON "Pairing"("pairCode");

-- CreateIndex
CREATE INDEX "Pairing_orgId_idx" ON "Pairing"("orgId");

-- CreateIndex
CREATE INDEX "TelemetrySample_vehicleId_ts_idx" ON "TelemetrySample"("vehicleId", "ts");

-- CreateIndex
CREATE INDEX "TelemetrySample_orgId_idx" ON "TelemetrySample"("orgId");

-- CreateIndex
CREATE INDEX "TelemetrySample_ts_idx" ON "TelemetrySample"("ts");

-- CreateIndex
CREATE INDEX "TelemetrySnapshot_vehicleId_ts_idx" ON "TelemetrySnapshot"("vehicleId", "ts");

-- CreateIndex
CREATE INDEX "TelemetrySnapshot_orgId_idx" ON "TelemetrySnapshot"("orgId");

-- CreateIndex
CREATE INDEX "TelemetryRecord_vehicleId_timestamp_idx" ON "TelemetryRecord"("vehicleId", "timestamp");

-- CreateIndex
CREATE INDEX "TelemetryRecord_identifier_idx" ON "TelemetryRecord"("identifier");

-- CreateIndex
CREATE INDEX "TelemetryRecord_orgId_idx" ON "TelemetryRecord"("orgId");

-- CreateIndex
CREATE INDEX "ModelState_orgId_idx" ON "ModelState"("orgId");

-- CreateIndex
CREATE INDEX "MlModelArtifact_modelVersion_createdAt_idx" ON "MlModelArtifact"("modelVersion", "createdAt");

-- CreateIndex
CREATE INDEX "MlBaselineProfile_make_model_vehicleClass_idx" ON "MlBaselineProfile"("make", "model", "vehicleClass");

-- CreateIndex
CREATE INDEX "MlPredictionRun_vehicleId_createdAt_idx" ON "MlPredictionRun"("vehicleId", "createdAt");

-- CreateIndex
CREATE INDEX "MlPredictionRun_orgId_createdAt_idx" ON "MlPredictionRun"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "MlFeatureSnapshot_vehicleId_createdAt_idx" ON "MlFeatureSnapshot"("vehicleId", "createdAt");

-- CreateIndex
CREATE INDEX "Baseline_vehicleId_idx" ON "Baseline"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "Baseline_vehicleId_metricKey_windowDays_key" ON "Baseline"("vehicleId", "metricKey", "windowDays");

-- CreateIndex
CREATE INDEX "TrendSignal_vehicleId_ruleId_status_idx" ON "TrendSignal"("vehicleId", "ruleId", "status");

-- CreateIndex
CREATE INDEX "PartnerWebhook_apiKeyId_idx" ON "PartnerWebhook"("apiKeyId");

-- CreateIndex
CREATE INDEX "PartnerWebhook_partner_active_idx" ON "PartnerWebhook"("partner", "active");

-- CreateIndex
CREATE INDEX "FeedbackLog_vehicleId_idx" ON "FeedbackLog"("vehicleId");

-- CreateIndex
CREATE INDEX "FeedbackLog_outcome_idx" ON "FeedbackLog"("outcome");

-- CreateIndex
CREATE INDEX "FeedbackLog_createdAt_idx" ON "FeedbackLog"("createdAt");

-- CreateIndex
CREATE INDEX "PatternSignature_vehicleId_idx" ON "PatternSignature"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "PatternSignature_vehicleId_maintenanceType_metricKey_preWin_key" ON "PatternSignature"("vehicleId", "maintenanceType", "metricKey", "preWindowDays");

-- CreateIndex
CREATE INDEX "Recommendation_vehicleId_status_idx" ON "Recommendation"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "Alert_vehicleId_createdAt_idx" ON "Alert"("vehicleId", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_orgId_createdAt_idx" ON "Alert"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_resolved_idx" ON "Alert"("resolved");

-- CreateIndex
CREATE INDEX "Event_orgId_vehicleId_idx" ON "Event"("orgId", "vehicleId");

-- CreateIndex
CREATE INDEX "Event_dedupeKey_status_idx" ON "Event"("dedupeKey", "status");

-- CreateIndex
CREATE INDEX "Notification_orgId_status_idx" ON "Notification"("orgId", "status");

-- CreateIndex
CREATE INDEX "Notification_recipientId_status_idx" ON "Notification"("recipientId", "status");

-- CreateIndex
CREATE INDEX "AiReport_vehicleId_createdAt_idx" ON "AiReport"("vehicleId", "createdAt");

-- CreateIndex
CREATE INDEX "FuelEvent_vehicleId_idx" ON "FuelEvent"("vehicleId");

-- CreateIndex
CREATE INDEX "FuelEvent_orgId_idx" ON "FuelEvent"("orgId");

-- CreateIndex
CREATE INDEX "MaintenanceLog_vehicleId_performedAt_idx" ON "MaintenanceLog"("vehicleId", "performedAt");

-- CreateIndex
CREATE INDEX "MaintenanceLog_orgId_idx" ON "MaintenanceLog"("orgId");

-- CreateIndex
CREATE INDEX "WorkOrder_vehicleId_idx" ON "WorkOrder"("vehicleId");

-- CreateIndex
CREATE INDEX "WorkOrder_orgId_status_idx" ON "WorkOrder"("orgId", "status");

-- CreateIndex
CREATE INDEX "WorkOrderLine_workOrderId_idx" ON "WorkOrderLine"("workOrderId");

-- CreateIndex
CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- CreateIndex
CREATE INDEX "Lead_orgId_idx" ON "Lead"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_token_key" ON "Invite"("token");

-- CreateIndex
CREATE INDEX "Invite_token_idx" ON "Invite"("token");

-- CreateIndex
CREATE INDEX "Invite_orgId_idx" ON "Invite"("orgId");

-- CreateIndex
CREATE INDEX "AuditLog_orgId_idx" ON "AuditLog"("orgId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_keyHash_idx" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_orgId_idx" ON "ApiKey"("orgId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSettings" ADD CONSTRAINT "TenantSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgBillingSettings" ADD CONSTRAINT "OrgBillingSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetAddon" ADD CONSTRAINT "FleetAddon_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("driverId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetrySample" ADD CONSTRAINT "TelemetrySample_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetrySnapshot" ADD CONSTRAINT "TelemetrySnapshot_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryRecord" ADD CONSTRAINT "TelemetryRecord_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelState" ADD CONSTRAINT "ModelState_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlPredictionRun" ADD CONSTRAINT "MlPredictionRun_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlFeatureSnapshot" ADD CONSTRAINT "MlFeatureSnapshot_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Baseline" ADD CONSTRAINT "Baseline_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendSignal" ADD CONSTRAINT "TrendSignal_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleCapability" ADD CONSTRAINT "VehicleCapability_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiReport" ADD CONSTRAINT "AiReport_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelEvent" ADD CONSTRAINT "FuelEvent_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceLog" ADD CONSTRAINT "MaintenanceLog_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceLog" ADD CONSTRAINT "MaintenanceLog_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderLine" ADD CONSTRAINT "WorkOrderLine_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

