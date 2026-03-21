function registerAuthRoutes(app, deps) {
  const {
    authLog,
    readData,
    restoreUsersIfEmpty,
    ensureBootstrapCustomer,
    authService,
    IS_PROD,
    DEV_SETUP,
    DEV_SETUP_PASSWORD,
    AUTH_ERRORS,
    issueSession,
    setCustomerSessionCookie,
    setSessionCookie,
    sendEmployeeLoginResponse,
    formatAuthError,
    setNoStore,
    requireCustomerApi,
    getCustomerSession,
    clearCustomerSessionCookie,
    customerSessionStore,
    persistSessionStoresSoon,
    getSessionFromRequest,
    getSession,
    clearSessionCookie,
    sessionStore,
    bcrypt,
    nowIso,
    sanitizeString,
    requireSuperAdmin,
    requireEmployeeSession,
    requireEmployeeApi,
    requireRole,
    addAudit,
    writeData
  } = deps;

  async function handleCustomerLogin(req, res, next) {
    const { email, password } = req.body || {};
    authLog(`[REQ] ${req.method} ${req.path}`);
    authLog(`[AUTH-CUSTOMER] login attempt ${email || "unknown"}`);
    try {
      let data = await readData();
      const restored = await restoreUsersIfEmpty(data);
      data = restored.data;
      const boot = await ensureBootstrapCustomer(data);
      if (boot.created) {
        data = await readData();
      }
      const result = await authService.authenticate("customer", email, password);
      if (!result.ok) {
        if (!IS_PROD && DEV_SETUP && result.error.code === AUTH_ERRORS.INVALID_CREDENTIALS.code && password && password === DEV_SETUP_PASSWORD) {
          const devLookup = await authService.getUserByEmail("customer", email);
          if (devLookup && devLookup.user) {
            const devSession = issueSession("customer", devLookup.user);
            setCustomerSessionCookie(res, devSession.id);
            return res.status(200).json({
              ok: true,
              code: "OK",
              message: "Authenticated",
              session: {
                expiresAt: devSession.expiresAt,
                user: {
                  id: devLookup.user.id,
                  email: devLookup.user.email,
                  role: devLookup.user.role,
                  orgId: devLookup.user.orgId || null,
                  displayName: devLookup.user.displayName || ""
                }
              },
              user: {
                id: devLookup.user.id,
                email: devLookup.user.email,
                role: devLookup.user.role,
                orgId: devLookup.user.orgId || null,
                displayName: devLookup.user.displayName || ""
              }
            });
          }
        }
        if (result.error.code === AUTH_ERRORS.PASSWORD_SETUP_REQUIRED.code) {
          return res.status(result.error.status).json({
            ok: false,
            code: result.error.code,
            setupToken: result.next.token,
            email: authService.normalizeEmail(email),
            message: result.error.message
          });
        }
        return res.status(result.error.status).json({ ok: false, code: result.error.code, message: result.error.message });
      }
      const session = result.session;
      console.log("[CUST-LOGIN] success", {
        email: result.user.email,
        userId: result.user.id || null,
        role: result.user.role,
        orgId: result.user.orgId || null,
        sessionId: session.id,
        cookieName: "fleetai_customer_session",
        ua: req.headers["user-agent"] || "",
        origin: req.headers.origin || "",
        referer: req.headers.referer || ""
      });
      setCustomerSessionCookie(res, session.id);
      return res.status(200).json({
        ok: true,
        code: "OK",
        message: "Authenticated",
        session: {
          expiresAt: session.expiresAt,
          user: { id: result.user.id, email: result.user.email, role: result.user.role, orgId: result.user.orgId || null, displayName: result.user.displayName || "" }
        },
        user: { id: result.user.id, email: result.user.email, role: result.user.role, orgId: result.user.orgId || null, displayName: result.user.displayName || "" }
      });
    } catch (err) {
      next(err);
    }
  }

  function sendEmployeeError(res, err) {
    return sendEmployeeLoginResponse(res, 500, formatAuthError(AUTH_ERRORS.SERVER_MISCONFIG, { message: "Server error" }));
  }

  async function handleEmployeeLogin(req, res) {
    const { email, password } = req.body || {};
    let step = "start";
    authLog(`[REQ] ${req.method} ${req.path}`);
    authLog(`[AUTH] login attempt ${email || "unknown"}`);
    try {
      const result = await authService.authenticate("employee", email, password);
      if (!result.ok) {
        if (!IS_PROD && DEV_SETUP && result.error.code === AUTH_ERRORS.INVALID_CREDENTIALS.code && password && password === DEV_SETUP_PASSWORD) {
          const devLookup = await authService.getUserByEmail("employee", email);
          if (devLookup && devLookup.user) {
            const devSession = issueSession("employee", devLookup.user);
            setSessionCookie(res, devSession.id);
            return sendEmployeeLoginResponse(res, 200, {
              ok: true,
              success: true,
              session: {
                expiresAt: devSession.expiresAt
              },
              user: {
                id: devLookup.user.id || null,
                email: devLookup.user.email,
                role: "employee",
                permissionRole: devLookup.user.role
              },
              redirect: "/employee-console.html"
            });
          }
        }
        if (result.error.code === AUTH_ERRORS.PASSWORD_SETUP_REQUIRED.code) {
          return sendEmployeeLoginResponse(res, result.error.status, {
            ok: false,
            success: false,
            code: result.error.code,
            setupToken: result.next.token,
            email: authService.normalizeEmail(email),
            message: result.error.message
          });
        }
        return sendEmployeeLoginResponse(res, result.error.status, {
          ok: false,
          success: false,
          code: result.error.code,
          message: result.error.message
        });
      }
      const session = result.session;
      setSessionCookie(res, session.id);
      return sendEmployeeLoginResponse(res, 200, {
        ok: true,
        success: true,
        session: {
          expiresAt: session.expiresAt
        },
        user: {
          id: result.user.id || null,
          email: result.user.email,
          role: "employee",
          permissionRole: result.user.role
        },
        redirect: "/employee-console.html"
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.log("[AUTH] login error", { step, message });
      return sendEmployeeError(res, err);
    }
  }

  function handleEmployeeLoginRoute(req, res) {
    if (req.method !== "POST") {
      return sendEmployeeLoginResponse(res, 405, { ok: false, success: false, error: "Method not allowed" });
    }
    return handleEmployeeLogin(req, res);
  }

  app.post("/api/auth/org/login", (req, res, next) => { setNoStore(res); return handleCustomerLogin(req, res, next); });
  app.post("/api/auth/customer/login", (req, res, next) => { setNoStore(res); return handleCustomerLogin(req, res, next); });
  app.post("/api/auth/login", (req, res, next) => { setNoStore(res); return handleCustomerLogin(req, res, next); });
  app.post("/api/auth/login-customer", (req, res, next) => { setNoStore(res); return handleCustomerLogin(req, res, next); });
  app.post("/api/customer/login", (req, res, next) => { setNoStore(res); return handleCustomerLogin(req, res, next); });

  app.get("/api/auth/customer/session", (req, res) => {
    const session = getCustomerSession(req);
    console.log("[CUST-SESSION] check", {
      hasCookieHeader: Boolean(req.headers.cookie),
      sessionFound: Boolean(session),
      sessionUserId: session?.userId || null,
      sessionEmail: session?.email || null,
      ua: req.headers["user-agent"] || "",
      referer: req.headers.referer || ""
    });
    if (!session) {
      return res.status(401).json({ error: "Not authenticated." });
    }
    res.json({ ok: true, user: { id: session.userId, email: session.email, role: session.role, orgId: session.orgId } });
  });

  app.get("/api/auth/whoami", (req, res) => {
    const employee = getSession(req);
    if (employee) {
      return res.json({ ok: true, type: "employee", source: "cookie", user: { id: employee.userId || null, email: employee.email, role: employee.role, orgId: employee.orgId || null } });
    }
    const customer = getCustomerSession(req);
    if (customer) {
      return res.json({ ok: true, type: "customer", source: "cookie", user: { id: customer.userId, email: customer.email, role: customer.role, orgId: customer.orgId || null } });
    }
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  });

  app.get("/api/me", requireCustomerApi, (req, res) => {
    const session = req.customer;
    readData().then((data) => {
      const user = (data.users || []).find((u) => u.id === session.userId);
      res.json({
        ok: true,
        user: {
          id: session.userId,
          email: session.email,
          role: session.role,
          orgId: session.orgId,
          displayName: session.displayName || "",
          passwordLastSetAt: user?.passwordLastSetAt || user?.lastPasswordChangeAt || null,
          mustSetPassword: Boolean(user?.mustSetPassword || user?.isTemporaryPassword)
        },
        resetRequired: Boolean(session.resetRequired),
        requirePasswordReset: Boolean(session.resetRequired),
        mustResetPassword: Boolean(session.resetRequired),
        mustSetPassword: Boolean(session.mustSetPassword)
      });
    }).catch(() => {
      res.status(500).json({ error: "Failed to load profile." });
    });
  });

  app.post("/api/auth/reset-password", requireCustomerApi, async (req, res, next) => {
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 10) {
      return res.status(400).json({ error: "Password must be at least 10 characters." });
    }
    try {
      const data = await readData();
      const user = (data.users || []).find((u) => u.id === req.customer.userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!req.customer.resetRequired && !user.mustResetPassword && !user.requirePasswordReset) {
        return res.status(400).json({ error: "Password reset not required." });
      }
      user.passwordHash = await bcrypt.hash(String(newPassword), 12);
      user.mustResetPassword = false;
      user.requirePasswordReset = false;
      user.lastPasswordChangeAt = nowIso();
      user.passwordLastSetAt = nowIso();
      user.isTemporaryPassword = false;
      user.mustSetPassword = false;
      user.status = user.status || "ACTIVE";
      user.lastLoginAt = nowIso();
      await writeData(data);
      req.customer.resetRequired = false;
      req.customer.mustSetPassword = false;
      customerSessionStore.set(req.customer.id, req.customer);
      if (typeof persistSessionStoresSoon === "function") {
        persistSessionStoresSoon();
      }
      res.json({ ok: true, redirectTo: "/ui/fleetai-dashboard.html" });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/auth/org/reset-password", requireCustomerApi, (req, res, next) => {
    req.url = "/api/auth/reset-password";
    app.handle(req, res, next);
  });

  app.post("/api/auth/password/update", requireCustomerApi, async (req, res, next) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password required." });
    }
    if (String(newPassword).length < 10) {
      return res.status(400).json({ error: "Password must be at least 10 characters." });
    }
    try {
      const data = await readData();
      const user = (data.users || []).find((u) => u.id === req.customer.userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const ok = await bcrypt.compare(String(currentPassword), user.passwordHash || "");
      if (!ok) return res.status(401).json({ error: "Current password is incorrect." });
      user.passwordHash = await bcrypt.hash(String(newPassword), 12);
      user.mustResetPassword = false;
      user.requirePasswordReset = false;
      user.isTemporaryPassword = false;
      user.mustSetPassword = false;
      user.lastPasswordChangeAt = nowIso();
      user.passwordLastSetAt = nowIso();
      user.lastLoginAt = nowIso();
      await writeData(data);
      req.customer.resetRequired = false;
      req.customer.mustSetPassword = false;
      customerSessionStore.set(req.customer.id, req.customer);
      if (typeof persistSessionStoresSoon === "function") {
        persistSessionStoresSoon();
      }
      res.json({ ok: true, redirectTo: "/ui/fleetai-dashboard.html" });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/auth/customer/logout", (req, res) => {
    const session = getCustomerSession(req);
    if (session) {
      customerSessionStore.delete(session.id);
      if (typeof persistSessionStoresSoon === "function") {
        persistSessionStoresSoon();
      }
    }
    clearCustomerSessionCookie(res);
    res.json({ ok: true });
  });

  app.all("/api/employee/login", handleEmployeeLoginRoute);
  app.all("/api/login", handleEmployeeLoginRoute);
  app.all("/api/employee-login", handleEmployeeLoginRoute);
  app.all("/api/auth/employee/login", handleEmployeeLoginRoute);

  app.post("/api/employee/logout", (req, res) => {
    const session = getSession(req);
    if (session) {
      sessionStore.delete(session.id);
      if (typeof persistSessionStoresSoon === "function") {
        persistSessionStoresSoon();
      }
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    const session = getSession(req);
    if (session) {
      sessionStore.delete(session.id);
      if (typeof persistSessionStoresSoon === "function") {
        persistSessionStoresSoon();
      }
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  app.get("/api/employee/session", (req, res) => {
    const session = getSession(req);
    if (!session) {
      return res.status(401).json({ ok: false, error: "Not authenticated." });
    }
    return res.json({
      ok: true,
      employee: {
        id: session.userId || null,
        email: session.email,
        role: session.role,
        loginRole: session.loginRole || "employee"
      }
    });
  });

  app.get("/api/employee/me", (req, res) => {
    req.url = "/api/employee/session";
    app.handle(req, res);
  });

  app.get("/api/employee/whoami", (req, res) => {
    req.url = "/api/employee/session";
    app.handle(req, res);
  });

  app.get("/api/auth/session", (req, res) => {
    const session = getSession(req);
    if (!session) {
      return res.status(401).json({ error: "Not authenticated." });
    }
    return res.json({ authenticated: true, user: { id: session.userId || null, email: session.email, role: session.role } });
  });
}

module.exports = {
  registerAuthRoutes
};
