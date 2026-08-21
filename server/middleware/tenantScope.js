"use strict";

const READ_ONLY_CUSTOMER_ROLES = new Set(["CUSTOMER_VIEWER", "VIEWER"]);

function normalizeOrgId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function suppliedOrgIds(req) {
  return [req.params?.orgId, req.query?.orgId, req.body?.orgId]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map(normalizeOrgId)
    .filter(Boolean);
}

function bindCustomerTenant(req, res, customer, { enforceReadOnly = false } = {}) {
  const orgId = normalizeOrgId(customer?.orgId);
  if (!orgId) {
    res.status(403).json({ ok: false, error: "org_scope_required" });
    return false;
  }

  if (suppliedOrgIds(req).some((requestedOrgId) => requestedOrgId !== orgId)) {
    res.status(403).json({ ok: false, error: "cross_org_access_denied" });
    return false;
  }

  const method = String(req.method || "GET").toUpperCase();
  const role = String(customer.role || "").toUpperCase();
  if (enforceReadOnly && !["GET", "HEAD", "OPTIONS"].includes(method) && READ_ONLY_CUSTOMER_ROLES.has(role)) {
    res.status(403).json({ ok: false, error: "read_only_role" });
    return false;
  }

  req.tenantOrgId = orgId;
  req.authScope = { kind: "customer", orgId, userId: customer.userId || null, role: customer.role || null };
  return true;
}

module.exports = {
  READ_ONLY_CUSTOMER_ROLES,
  bindCustomerTenant,
  normalizeOrgId,
  suppliedOrgIds
};
