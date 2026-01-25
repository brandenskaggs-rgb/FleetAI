const AUTH_ERRORS = {
  INVALID_CREDENTIALS: { status: 401, code: "INVALID_CREDENTIALS", message: "Invalid credentials" },
  USER_NOT_FOUND: { status: 401, code: "USER_NOT_FOUND", message: "User not found" },
  PASSWORD_SETUP_REQUIRED: { status: 409, code: "PASSWORD_SETUP_REQUIRED", message: "Password setup required" },
  ACCOUNT_LOCKED: { status: 423, code: "ACCOUNT_LOCKED", message: "Account locked" },
  SERVER_MISCONFIG: { status: 500, code: "SERVER_MISCONFIG", message: "Server misconfiguration" }
};

function formatAuthError(base, overrides = {}) {
  return Object.assign(
    { ok: false, error: base.code, code: base.code, message: base.message },
    overrides
  );
}

module.exports = { AUTH_ERRORS, formatAuthError };
