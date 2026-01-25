const adminState = {
  orgs: [],
  users: [],
  invites: [],
  leads: [],
  billing: {},
  features: {}
};

function $(id) {
  return document.getElementById(id);
}

async function apiJson(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
  if (res.status === 401 || res.status === 403) {
    window.location.href = "/employee-login.html";
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function setTitle(name) {
  const title = $("portalTitle");
  if (title) title.textContent = name;
}

function setModalError(message) {
  const error = document.getElementById("modalError");
  if (!error) return;
  if (!message) {
    error.style.display = "none";
    error.textContent = "";
    return;
  }
  error.style.display = "block";
  error.textContent = message;
}

function openModal({ title, content }) {
  const overlay = $("modalOverlay");
  const modalTitle = $("modalTitle");
  const modalBody = $("modalBody");
  if (!overlay || !modalTitle || !modalBody) return;
  modalTitle.textContent = title || "Modal";
  modalBody.innerHTML = `<div class="formError" id="modalError" style="display:none;"></div>${content || ""}`;
  overlay.hidden = false;
  overlay.classList.add("is-open");
  overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeModal() {
  const overlay = $("modalOverlay");
  if (!overlay) return;
  overlay.hidden = true;
  overlay.classList.remove("is-open");
  overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function optionList(items, selectedId) {
  if (!items.length) return `<option value=\"\">No orgs</option>`;
  return items
    .map((o) => `<option value=\"${o.id}\" ${o.id === selectedId ? "selected" : ""}>${o.name}</option>`)
    .join("");
}

function formatDate(value) {
  if (!value) return "--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function loadMe() {
  const data = await apiJson("/api/admin/me");
  if (!data) return;
  const roleEl = $("portalRole");
  if (roleEl) roleEl.textContent = `Role: ${data.user.role}`;
}

async function loadOverview() {
  const data = await apiJson("/api/admin/overview");
  if (!data) return;
  $("kpiMrr").textContent = data.data.mrrEstimate ?? "--";
  $("kpiActiveOrgs").textContent = data.data.activeOrgs ?? "--";
  $("kpiActivePilots").textContent = data.data.activePilots ?? "--";
  $("kpiActiveVehicles").textContent = data.data.activeVehicles ?? "--";
  const breakdown = Object.entries(data.data.leadsByStage || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(" | ");
  $("leadStageBreakdown").textContent = breakdown || "No lead data yet.";
}

function renderOrgs() {
  const body = $("orgTable");
  if (!body) return;
  body.innerHTML = adminState.orgs
    .map(
      (o) => `<tr>
        <td>${o.name}</td>
        <td>${o.status}</td>
        <td>${o.industry || "--"}</td>
        <td>${o.fleetSize ?? 0}</td>
        <td>${formatDate(o.updatedAt)}</td>
        <td>
          <button class="btn ghost" data-action="org-edit" data-id="${o.id}">Edit</button>
          <button class="btn ghost" data-action="org-status" data-id="${o.id}">Status</button>
        </td>
      </tr>`
    )
    .join("");
}

async function loadOrgs() {
  const data = await apiJson("/api/admin/orgs");
  if (!data) return;
  adminState.orgs = data.data || [];
  renderOrgs();
  const orgSelect = $("billingOrgSelect");
  const featSelect = $("featuresOrgSelect");
  if (orgSelect) orgSelect.innerHTML = optionList(adminState.orgs);
  if (featSelect) featSelect.innerHTML = optionList(adminState.orgs);
}

function renderUsers() {
  const body = $("userTable");
  if (!body) return;
  body.innerHTML = adminState.users
    .map(
      (u) => `<tr>
        <td>${u.email}</td>
        <td>${u.role}</td>
        <td>${u.orgId || "--"}</td>
        <td>${u.isActive === false ? "Disabled" : "Active"}</td>
        <td>${formatDate(u.lastLoginAt)}</td>
        <td>
          <button class="btn ghost" data-action="user-edit" data-id="${u.id}">Edit</button>
          <button class="btn ghost" data-action="user-role" data-id="${u.id}">Role</button>
          <button class="btn ghost" data-action="user-disable" data-id="${u.id}">Disable</button>
        </td>
      </tr>`
    )
    .join("");
}

async function loadUsers() {
  const data = await apiJson("/api/admin/users");
  if (!data) return;
  adminState.users = data.data || [];
  renderUsers();
}

function renderInvites() {
  const body = $("inviteTable");
  if (!body) return;
  body.innerHTML = adminState.invites
    .map(
      (i) => `<tr>
        <td><span class="mono">${i.token}</span></td>
        <td>${i.orgId}</td>
        <td>${i.type}</td>
        <td>${formatDate(i.expiresAt)}</td>
        <td>
          <button class="btn ghost" data-action="invite-copy" data-token="${i.token}">Copy</button>
          <button class="btn ghost" data-action="invite-revoke" data-id="${i.id}">Revoke</button>
        </td>
      </tr>`
    )
    .join("");
}

async function loadInvites() {
  const data = await apiJson("/api/admin/invites");
  if (!data) return;
  adminState.invites = data.data || [];
  renderInvites();
}

function renderLeads() {
  const body = $("leadTable");
  if (!body) return;
  body.innerHTML = adminState.leads
    .map(
      (l) => `<tr>
        <td>${l.companyName}</td>
        <td>${l.stage}</td>
        <td>${l.contactEmail || "--"}</td>
        <td>${l.demoDate ? formatDate(l.demoDate) : "--"}</td>
        <td>
          <button class="btn ghost" data-action="lead-edit" data-id="${l.id}">Edit</button>
          <button class="btn ghost" data-action="lead-convert" data-id="${l.id}">Convert</button>
        </td>
      </tr>`
    )
    .join("");
}

async function loadLeads() {
  const data = await apiJson("/api/admin/leads");
  if (!data) return;
  adminState.leads = data.data || [];
  renderLeads();
}

async function loadBilling(orgId) {
  if (!orgId) return;
  const data = await apiJson(`/api/admin/billing/${orgId}`);
  if (!data) return;
  const b = data.data;
  $("billingPlan").value = b.plan || "PILOT";
  $("billingPrice").value = b.pricePerVehicle ?? 0;
  $("billingVehicles").value = b.vehicleCount ?? 0;
  $("billingStatus").value = b.billingStatus || "NOT_BILLING";
  $("billingTerm").value = b.contractTermMonths ?? 0;
  $("billingMrr").value = b.mrrEstimate ?? 0;
}

async function loadFeatures(orgId) {
  if (!orgId) return;
  const data = await apiJson(`/api/admin/features/${orgId}`);
  if (!data) return;
  const f = data.data;
  $("featAiAdvisor").checked = !!f.aiAdvisor;
  $("featSafetyPack").checked = !!f.safetyPack;
  $("featCompliancePack").checked = !!f.compliancePack;
  $("featCameraIntegration").checked = !!f.cameraIntegration;
  $("featAdvancedDiagnostics").checked = !!f.advancedDiagnostics;
}

async function loadSystem() {
  const health = await apiJson("/health");
  if (health) {
    $("healthStatus").textContent = health.ok ? "Online" : "Degraded";
  }
  const routes = await apiJson("/api/debug/routes");
  if (routes) {
    $("healthMeta").textContent = `Port ${routes.port} | ${routes.dirname}`;
  }
  const overview = await apiJson("/api/admin/overview");
  if (overview) {
    $("healthCounts").textContent = `${overview.data.totalOrgs} orgs, ${overview.data.totalUsers} users`;
  }
}

async function loadAudit() {
  const data = await apiJson("/api/admin/audit");
  if (!data) return;
  const body = $("auditTable");
  if (!body) return;
  body.innerHTML = (data.data || [])
    .map((a) => `<tr><td>${formatDate(a.createdAt)}</td><td>${a.event}</td><td>${a.detail || ""}</td></tr>`)
    .join("");
}

async function loadSettings() {
  const data = await apiJson("/api/admin/settings");
  if (!data) return;
  $("settingsPilotPrice").value = data.data.defaultPilotPrice ?? 59;
  $("settingsInviteHours").value = data.data.inviteExpiryHours ?? 72;
  $("settingsMaintenance").value = String(!!data.data.maintenanceMode);
}

async function init() {
  await loadMe();
  await loadOverview();
  await loadOrgs();
  await loadUsers();
  await loadInvites();
  await loadLeads();
  await loadSettings();
  await loadSystem();
  await loadAudit();
  const orgSelect = $("billingOrgSelect");
  if (orgSelect) {
    orgSelect.addEventListener("change", () => loadBilling(orgSelect.value));
    if (orgSelect.value) loadBilling(orgSelect.value);
  }
  const featSelect = $("featuresOrgSelect");
  if (featSelect) {
    featSelect.addEventListener("change", () => loadFeatures(featSelect.value));
    if (featSelect.value) loadFeatures(featSelect.value);
  }
}

function bindNav() {
  const nav = $("adminNav");
  if (!nav) return;
  const panels = document.querySelectorAll("[data-panel]");
  nav.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      nav.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const key = btn.getAttribute("data-section");
      panels.forEach((panel) => {
        panel.hidden = panel.getAttribute("data-panel") !== key;
      });
      setTitle(btn.textContent);
    });
  });
}

function bindActions() {
  $("adminRefresh")?.addEventListener("click", init);
  $("modalClose")?.addEventListener("click", closeModal);

  $("orgCreateBtn")?.addEventListener("click", () => {
    openModal({
      title: "Create Organization",
      content: `<form id="orgCreateForm">
        <label class="field">Name<input name="name" required /></label>
        <label class="field">Industry<input name="industry" /></label>
        <label class="field">Fleet size<input name="fleetSize" type="number" min="0" /></label>
        <label class="field">Status
          <select name="status">
            <option value="DEMO">DEMO</option>
            <option value="PILOT">PILOT</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="SUSPENDED">SUSPENDED</option>
          </select>
        </label>
        <label class="field">Notes<textarea name="notes"></textarea></label>
        <div class="heroActions"><button class="btn primary" type="submit">Create</button></div>
      </form>`
    });
    document.getElementById("orgCreateForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const payload = Object.fromEntries(new FormData(form));
      payload.fleetSize = Number(payload.fleetSize || 0);
      try {
        await apiJson("/api/admin/orgs", { method: "POST", body: JSON.stringify(payload) });
        closeModal();
        await loadOrgs();
      } catch (err) {
        setModalError(err.message || "Failed to create org.");
      }
    });
  });

  $("userCreateBtn")?.addEventListener("click", () => {
    openModal({
      title: "Create User",
      content: `<form id="userCreateForm">
        <label class="field">Email<input name="email" type="email" required /></label>
        <label class="field">Role
          <select name="role">
            <option value="ADMIN">ADMIN</option>
            <option value="SUPPORT">SUPPORT</option>
            <option value="FLEET_MANAGER">FLEET_MANAGER</option>
            <option value="DRIVER">DRIVER</option>
            <option value="VIEW_ONLY">VIEW_ONLY</option>
          </select>
        </label>
        <label class="field">Org ID (optional)<input name="orgId" /></label>
        <label class="field">Password (optional)<input name="password" type="password" /></label>
        <div class="heroActions"><button class="btn primary" type="submit">Create</button></div>
      </form>`
    });
    document.getElementById("userCreateForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = Object.fromEntries(new FormData(e.target));
      try {
        await apiJson("/api/admin/users", { method: "POST", body: JSON.stringify(payload) });
        closeModal();
        await loadUsers();
      } catch (err) {
        setModalError(err.message || "Failed to create user.");
      }
    });
  });

  $("inviteCreateBtn")?.addEventListener("click", () => {
    const orgOptions = optionList(adminState.orgs);
    openModal({
      title: "Create Invite",
      content: `<form id="inviteCreateForm">
        <label class="field">Organization<select name="orgId">${orgOptions}</select></label>
        <label class="field">Type
          <select name="type">
            <option value="FLEET_MANAGER">Fleet Manager</option>
            <option value="DRIVER">Driver</option>
            <option value="EMPLOYEE">Employee</option>
          </select>
        </label>
        <div class="heroActions"><button class="btn primary" type="submit">Create</button></div>
      </form>`
    });
    document.getElementById("inviteCreateForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = Object.fromEntries(new FormData(e.target));
      try {
        await apiJson("/api/admin/invites", { method: "POST", body: JSON.stringify(payload) });
        closeModal();
        await loadInvites();
      } catch (err) {
        setModalError(err.message || "Failed to create invite.");
      }
    });
  });

  $("leadCreateBtn")?.addEventListener("click", () => {
    openModal({
      title: "Create Lead",
      content: `<form id="leadCreateForm">
        <label class="field">Company name<input name="companyName" required /></label>
        <label class="field">Contact name<input name="contactName" /></label>
        <label class="field">Contact email<input name="contactEmail" type="email" /></label>
        <label class="field">Contact phone<input name="contactPhone" /></label>
        <label class="field">Stage
          <select name="stage">
            <option value="LEAD">Lead</option>
            <option value="DEMO_SCHEDULED">Demo scheduled</option>
            <option value="DEMO_COMPLETE">Demo complete</option>
            <option value="PILOT_PROPOSED">Pilot proposed</option>
            <option value="WON">Won</option>
            <option value="LOST">Lost</option>
          </select>
        </label>
        <label class="field">Demo date<input name="demoDate" type="date" /></label>
        <label class="field">Notes<textarea name="notes"></textarea></label>
        <div class="heroActions"><button class="btn primary" type="submit">Create</button></div>
      </form>`
    });
    document.getElementById("leadCreateForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = Object.fromEntries(new FormData(e.target));
      try {
        await apiJson("/api/admin/leads", { method: "POST", body: JSON.stringify(payload) });
        closeModal();
        await loadLeads();
      } catch (err) {
        setModalError(err.message || "Failed to create lead.");
      }
    });
  });

  $("billingSave")?.addEventListener("click", async () => {
    const orgId = $("billingOrgSelect").value;
    if (!orgId) return;
    const payload = {
      plan: $("billingPlan").value,
      pricePerVehicle: Number($("billingPrice").value || 0),
      vehicleCount: Number($("billingVehicles").value || 0),
      billingStatus: $("billingStatus").value,
      contractTermMonths: Number($("billingTerm").value || 0)
    };
    const data = await apiJson(`/api/admin/billing/${orgId}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    if (data) $("billingMrr").value = data.data.mrrEstimate ?? 0;
  });

  $("featuresSave")?.addEventListener("click", async () => {
    const orgId = $("featuresOrgSelect").value;
    if (!orgId) return;
    const payload = {
      aiAdvisor: $("featAiAdvisor").checked,
      safetyPack: $("featSafetyPack").checked,
      compliancePack: $("featCompliancePack").checked,
      cameraIntegration: $("featCameraIntegration").checked,
      advancedDiagnostics: $("featAdvancedDiagnostics").checked
    };
    await apiJson(`/api/admin/features/${orgId}`, { method: "PUT", body: JSON.stringify(payload) });
  });

  $("settingsSave")?.addEventListener("click", async () => {
    const payload = {
      defaultPilotPrice: Number($("settingsPilotPrice").value || 0),
      inviteExpiryHours: Number($("settingsInviteHours").value || 72),
      maintenanceMode: $("settingsMaintenance").value === "true"
    };
    await apiJson("/api/admin/settings", { method: "PUT", body: JSON.stringify(payload) });
  });

  document.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute("data-action");
    if (!action) return;
    if (action === "invite-revoke") {
      await apiJson(`/api/admin/invites/${target.getAttribute("data-id")}`, { method: "DELETE" });
      await loadInvites();
    }
    if (action === "invite-copy") {
      const token = target.getAttribute("data-token");
      navigator.clipboard?.writeText(`${window.location.origin}/signup.html?token=${token}`);
    }
    if (action === "org-edit") {
      const org = adminState.orgs.find((o) => o.id === target.getAttribute("data-id"));
      if (!org) return;
      openModal({
        title: "Edit Organization",
        content: `<form id="orgEditForm">
          <label class="field">Name<input name="name" value="${org.name}" required /></label>
          <label class="field">Industry<input name="industry" value="${org.industry || ""}" /></label>
          <label class="field">Fleet size<input name="fleetSize" type="number" min="0" value="${org.fleetSize || 0}" /></label>
          <label class="field">Notes<textarea name="notes">${org.notes || ""}</textarea></label>
          <div class="heroActions"><button class="btn primary" type="submit">Save</button></div>
        </form>`
      });
      document.getElementById("orgEditForm").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const payload = Object.fromEntries(new FormData(ev.target));
        payload.fleetSize = Number(payload.fleetSize || 0);
        try {
          await apiJson(`/api/admin/orgs/${org.id}`, { method: "PUT", body: JSON.stringify(payload) });
          closeModal();
          await loadOrgs();
        } catch (err) {
          setModalError(err.message || "Failed to update org.");
        }
      });
    }
    if (action === "org-status") {
      const org = adminState.orgs.find((o) => o.id === target.getAttribute("data-id"));
      if (!org) return;
      openModal({
        title: "Update Status",
        content: `<form id="orgStatusForm">
          <label class="field">Status
            <select name="status">
              <option value="DEMO">DEMO</option>
              <option value="PILOT">PILOT</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="SUSPENDED">SUSPENDED</option>
            </select>
          </label>
          <div class="heroActions"><button class="btn primary" type="submit">Update</button></div>
        </form>`
      });
      document.querySelector("#orgStatusForm select").value = org.status;
      document.getElementById("orgStatusForm").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const payload = Object.fromEntries(new FormData(ev.target));
        try {
          await apiJson(`/api/admin/orgs/${org.id}/status`, { method: "PUT", body: JSON.stringify(payload) });
          closeModal();
          await loadOrgs();
        } catch (err) {
          setModalError(err.message || "Failed to update status.");
        }
      });
    }
    if (action === "user-edit") {
      const user = adminState.users.find((u) => u.id === target.getAttribute("data-id"));
      if (!user) return;
      openModal({
        title: "Edit User",
        content: `<form id="userEditForm">
          <label class="field">Email<input name="email" value="${user.email}" required /></label>
          <label class="field">Org ID<input name="orgId" value="${user.orgId || ""}" /></label>
          <label class="field">Active
            <select name="isActive">
              <option value="true">Active</option>
              <option value="false">Disabled</option>
            </select>
          </label>
          <div class="heroActions"><button class="btn primary" type="submit">Save</button></div>
        </form>`
      });
      document.querySelector("#userEditForm select").value = String(user.isActive !== false);
      document.getElementById("userEditForm").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const payload = Object.fromEntries(new FormData(ev.target));
        payload.isActive = payload.isActive === "true";
        try {
          await apiJson(`/api/admin/users/${user.id}`, { method: "PUT", body: JSON.stringify(payload) });
          closeModal();
          await loadUsers();
        } catch (err) {
          setModalError(err.message || "Failed to update user.");
        }
      });
    }
    if (action === "user-role") {
      const user = adminState.users.find((u) => u.id === target.getAttribute("data-id"));
      if (!user) return;
      openModal({
        title: "Update Role",
        content: `<form id="userRoleForm">
          <label class="field">Role
            <select name="role">
              <option value="SUPER_ADMIN">SUPER_ADMIN</option>
              <option value="ADMIN">ADMIN</option>
              <option value="SUPPORT">SUPPORT</option>
              <option value="FLEET_MANAGER">FLEET_MANAGER</option>
              <option value="DRIVER">DRIVER</option>
              <option value="VIEW_ONLY">VIEW_ONLY</option>
            </select>
          </label>
          <div class="heroActions"><button class="btn primary" type="submit">Update</button></div>
        </form>`
      });
      document.querySelector("#userRoleForm select").value = user.role;
      document.getElementById("userRoleForm").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const payload = Object.fromEntries(new FormData(ev.target));
        try {
          await apiJson(`/api/admin/users/${user.id}/role`, { method: "PUT", body: JSON.stringify(payload) });
          closeModal();
          await loadUsers();
        } catch (err) {
          setModalError(err.message || "Failed to update role.");
        }
      });
    }
    if (action === "user-disable") {
      await apiJson(`/api/admin/users/${target.getAttribute("data-id")}/disable`, { method: "PUT" });
      await loadUsers();
    }
    if (action === "lead-edit") {
      const lead = adminState.leads.find((l) => l.id === target.getAttribute("data-id"));
      if (!lead) return;
      openModal({
        title: "Edit Lead",
        content: `<form id="leadEditForm">
          <label class="field">Company name<input name="companyName" value="${lead.companyName}" required /></label>
          <label class="field">Stage
            <select name="stage">
              <option value="LEAD">Lead</option>
              <option value="DEMO_SCHEDULED">Demo scheduled</option>
              <option value="DEMO_COMPLETE">Demo complete</option>
              <option value="PILOT_PROPOSED">Pilot proposed</option>
              <option value="WON">Won</option>
              <option value="LOST">Lost</option>
            </select>
          </label>
          <label class="field">Contact email<input name="contactEmail" value="${lead.contactEmail || ""}" /></label>
          <label class="field">Notes<textarea name="notes">${lead.notes || ""}</textarea></label>
          <div class="heroActions"><button class="btn primary" type="submit">Save</button></div>
        </form>`
      });
      document.querySelector("#leadEditForm select").value = lead.stage;
      document.getElementById("leadEditForm").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const payload = Object.fromEntries(new FormData(ev.target));
        try {
          await apiJson(`/api/admin/leads/${lead.id}`, { method: "PUT", body: JSON.stringify(payload) });
          closeModal();
          await loadLeads();
        } catch (err) {
          setModalError(err.message || "Failed to update lead.");
        }
      });
    }
    if (action === "lead-convert") {
      await apiJson(`/api/admin/leads/${target.getAttribute("data-id")}/convert-to-org`, { method: "POST" });
      await loadLeads();
      await loadOrgs();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindNav();
  bindActions();
  init();

  const overlay = $("modalOverlay");
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.hasAttribute("data-modal-close")) {
        closeModal();
      }
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modal = $("modalOverlay");
      if (modal && !modal.hidden) closeModal();
    }
  });
});
