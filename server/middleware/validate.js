const { z } = require("zod");

// Express middleware factory: validates req.body against a Zod schema.
// On failure returns 400 with structured error details.
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message
      }));
      return res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid request body.", issues },
        timestamp: new Date().toISOString()
      });
    }
    req.body = result.data;
    return next();
  };
}

// ── Schemas ────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email("Must be a valid email address.").max(200),
  password: z.string().min(1, "Password is required.").max(200)
});

const passwordUpdateSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required."),
  newPassword: z.string().min(10, "New password must be at least 10 characters.").max(200)
});

const passwordSetSchema = z.object({
  password: z.string().min(10, "Password must be at least 10 characters.").max(200)
});

const apiKeyCreateSchema = z.object({
  partnerName: z.string().min(1, "partnerName is required.").max(200),
  orgId: z.string().max(100).optional().nullable(),
  // Must match scripts/provision-partner.js's VALID_TIERS and the literal
  // "partner_ml" partnerRoutes.js's auth guard checks for — this enum
  // previously omitted "partner_ml"/"enterprise", so the admin UI (which
  // defaults new partner keys to tier:"partner_ml") could never actually
  // create one through POST /api/admin/api-keys.
  tier: z.enum(["standard", "premium", "internal", "partner_ml", "enterprise"]).optional()
});

const leadCreateSchema = z.object({
  companyName: z.string().min(1, "companyName is required.").max(200),
  contactName: z.string().min(1, "contactName is required.").max(200),
  email: z.string().email("Must be a valid email.").max(200).optional(),
  contactEmail: z.string().email("Must be a valid email.").max(200).optional(),
  phone: z.string().max(80).optional().default(""),
  contactPhone: z.string().max(80).optional().default(""),
  fleetSize: z.string().max(50).optional().default(""),
  message: z.string().max(1200).optional().default("")
}).refine((d) => d.email || d.contactEmail, {
  message: "email or contactEmail is required.",
  path: ["email"]
});

const orgCreateSchema = z.object({
  name: z.string().min(1, "name is required.").max(200),
  primaryContactName: z.string().min(1, "primaryContactName is required.").max(200),
  primaryContactEmail: z.string().email("Must be a valid email.").max(200),
  phone: z.string().max(80).optional().default(""),
  status: z.string().max(20).optional(),
  fleetSizeEstimate: z.number().int().min(0).optional(),
  activeVehicles: z.number().int().min(0).optional(),
  billingPlan: z.string().max(80).optional(),
  notes: z.string().max(1200).optional().default("")
});

const inviteAcceptSchema = z.object({
  email: z.string().email("Must be a valid email.").max(200),
  password: z.string().min(10, "Password must be at least 10 characters.").max(200)
});

const telemetrySnapshotSchema = z.object({
  vehicleId: z.string().min(1, "vehicleId is required.").max(80),
  timestamp: z.string().optional(),
  pids: z.record(z.union([z.number(), z.null()])).optional().default({}),
  dtcs: z.array(z.string()).optional().default([]),
  driverId: z.string().max(80).optional().nullable(),
  deviceId: z.string().max(80).optional().nullable(),
  odometer: z.number().optional().nullable(),
  engineHours: z.number().optional().nullable()
});

module.exports = {
  validateBody,
  schemas: {
    login: loginSchema,
    passwordUpdate: passwordUpdateSchema,
    passwordSet: passwordSetSchema,
    apiKeyCreate: apiKeyCreateSchema,
    leadCreate: leadCreateSchema,
    orgCreate: orgCreateSchema,
    inviteAccept: inviteAcceptSchema,
    telemetrySnapshot: telemetrySnapshotSchema
  }
};
