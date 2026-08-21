window.__EMP_PORTAL_BOOT = true;
const adminState = {
  orgs: [],
  leads: [],
  users: [],
  invites: [],
  audit: [],
  selectedOrgId: null,
  selectedLeadId: null,
  leadFilter: "ALL",
  showDeletedOrgs: false,
  role: "",
  currentRoute: "overview",
  lastError: "",
  debug: {
    endpoint: "--",
    status: "--",
    error: "--",
    token: "--",
    cookie: "--",
    authType: "--",
    whoami: "--"
  }
};

function resolveApiUrl(path) {
  if (typeof window.apiUrl === "function") return window.apiUrl(path);
  const base = window.__FLEETAI__?.apiBase || "";
  if (!base) return path;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

const LOCAL_FLAGS_KEY = "fleetai.portal.flags";
const LOCAL_DENSITY_KEY = "fleetai.portal.density";
const DIAG_ENABLED = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("diag") === "1") return true;
    return localStorage.getItem("fleetai.diagnostics") === "true";
  } catch (e) {
    return false;
  }
})();

function diagLog(...args) {
  if (!DIAG_ENABLED) return;
  console.log("[diagnostics]", ...args);
}

function $(id) {
  return document.getElementById(id);
}

function updateConsoleDebug(partial) {
  adminState.debug = Object.assign({}, adminState.debug, partial || {});
  const endpointEl = $("consoleDbgEndpoint");
  const statusEl = $("consoleDbgStatus");
  const errorEl = $("consoleDbgError");
  const tokenEl = $("consoleDbgToken");
  const cookieEl = $("consoleDbgCookie");
  const authTypeEl = $("consoleDbgAuthType");
  const whoamiEl = $("consoleDbgWhoami");
  if (endpointEl) endpointEl.textContent = adminState.debug.endpoint || "--";
  if (statusEl) statusEl.textContent = adminState.debug.status || "--";
  if (errorEl) errorEl.textContent = adminState.debug.error || "--";
  if (tokenEl) tokenEl.textContent = adminState.debug.token || "--";
  if (cookieEl) cookieEl.textContent = adminState.debug.cookie || "--";
  if (authTypeEl) authTypeEl.textContent = adminState.debug.authType || "--";
  if (whoamiEl) whoamiEl.textContent = adminState.debug.whoami || "--";
}

let uiBlockTimer = null;
function setLoading(isLoading, reason) {
  const blocker = $("consoleOverlay");
  const root = document.querySelector(".employeeShell");
  if (root) root.style.pointerEvents = "auto";
  if (!blocker) {
    diagLog("ui blocker missing");
    return;
  }
  const note = blocker.querySelector(".uiBlockerNote");
  if (note && reason) note.textContent = String(reason);
  if (isLoading) {
    blocker.hidden = false;
    blocker.style.display = "flex";
    blocker.classList.add("is-active");
    blocker.setAttribute("aria-hidden", "false");
    if (uiBlockTimer) clearTimeout(uiBlockTimer);
    uiBlockTimer = setTimeout(() => {
      setLoading(false, "");
      setPortalError("Console took too long to load. Please retry.");
      renderPortalError();
    }, 3000);
    return;
  }
  if (uiBlockTimer) clearTimeout(uiBlockTimer);
  uiBlockTimer = null;
  blocker.classList.remove("is-active");
  blocker.hidden = true;
  blocker.style.display = "none";
  blocker.style.pointerEvents = "none";
  blocker.setAttribute("aria-hidden", "true");
}

function clearLegacyEmployeeTokens() {
  try {
    localStorage.removeItem("fleetai_employee_token");
    localStorage.removeItem("fleetai.employeeToken");
    localStorage.removeItem("employeeToken");
    localStorage.removeItem("authToken");
  } catch (e) {}
  try {
    sessionStorage.removeItem("fleetai_employee_token");
    sessionStorage.removeItem("fleetai.employeeToken");
  } catch (e) {}
}

async function apiJson(path, opts) {
  diagLog("request", opts?.method || "GET", path);
  const url = resolveApiUrl(path);
  const controller = new AbortController();
  const method = String(opts?.method || "GET").toUpperCase();
  const timeoutMs = method === "GET" ? 8000 : 15000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const requestHeaders = Object.assign({ "Content-Type": "application/json" }, opts?.headers || {});
  diagLog("request headers", path, requestHeaders);
  updateConsoleDebug({
    endpoint: url,
    status: "pending",
    error: "--"
  });
  try {
    const res = await fetch(url, Object.assign({
      headers: requestHeaders,
      credentials: "include",
      signal: controller.signal
    }, opts || {}));
    updateConsoleDebug({ status: String(res.status) });
    if (res.status === 401 || res.status === 403) {
      updateConsoleDebug({ error: "unauthorized" });
      window.location.href = "/employee-login.html";
      return null;
    }
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      updateConsoleDebug({ error: "invalid json" });
      throw new Error("Invalid JSON response");
    }
    diagLog("response", res.status, path, data);
    if (!res.ok) {
      const requestError = new Error(data.error || "Request failed");
      requestError.status = res.status;
      requestError.code = data.code || "";
      requestError.data = data;
      throw requestError;
    }
    return data;
  } catch (err) {
    const message = err && err.name === "AbortError"
      ? "Request timed out"
      : (err && err.message ? err.message : "Request failed");
    updateConsoleDebug({ error: message });
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

function setViewTitle(title, subtitle) {
  const titleEl = $("viewTitle");
  const subtitleEl = $("viewSubtitle");
  if (titleEl) titleEl.textContent = title;
  if (subtitleEl) subtitleEl.textContent = subtitle;
}

function setPortalError(message) {
  adminState.lastError = message || "";
}

function showToast(message, tone = "") {
  const region = $("portalToastRegion");
  if (!region || !message) return;
  const toast = document.createElement("div");
  toast.className = `portalToast ${tone}`.trim();
  toast.textContent = message;
  region.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

async function copyText(value, successMessage) {
  const text = String(value || "").trim();
  if (!text || text === "--") return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage || "Copied to clipboard.", "good");
  } catch (error) {
    showToast("Copy failed. Select the value and copy it manually.", "bad");
  }
}

function renderPortalError() {
  if (!adminState.lastError) return;
  const view = $("portalView");
  if (!view) return;
  const banner = document.createElement("div");
  banner.className = "emptyState";
  banner.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <div><strong>Failed to load data.</strong> ${adminState.lastError}</div>
      <button class="btn secondary" id="portalRetryBtn" type="button">Retry</button>
    </div>
  `;
  view.prepend(banner);
  const retry = document.getElementById("portalRetryBtn");
  if (retry) {
    retry.addEventListener("click", () => {
      setPortalError("");
      renderView(adminState.currentRoute);
    });
  }
}

function formatDate(value) {
  if (!value) return "--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleDateString();
}

function formatDateTime(value) {
  if (!value) return "--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "--";
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function formatStatus(value) {
  const raw = String(value || "").toUpperCase();
  const map = {
    LEAD: "Lead",
    PILOT: "Pilot",
    ACTIVE: "Active",
    PAUSED: "Paused",
    CHURNED: "Churned",
    DELETED: "Deleted",
    NEW: "New",
    CONTACTED: "Contacted",
    QUALIFIED: "Scheduled",
    SCHEDULED: "Scheduled",
    CONVERTED: "Converted",
    CLOSED: "Closed",
    LOST: "Closed"
  };
  return map[raw] || value || "--";
}

function formatLeadType(value) {
  const raw = String(value || "").toUpperCase();
  if (raw === "PILOT") return "Pilot";
  if (raw === "DEMO") return "Demo";
  return value || "--";
}

function roleAllowsOrgEdit() {
  return adminState.role === "SUPER_ADMIN";
}

function roleAllowsLeadEdit() {
  return ["SUPER_ADMIN", "ADMIN", "SUPPORT"].includes(adminState.role);
}

function roleAllowsLeadConvert() {
  return adminState.role === "SUPER_ADMIN";
}

function roleAllowsEmployeeEdit() {
  return adminState.role === "SUPER_ADMIN";
}

function loadDensitySetting() {
  try {
    return localStorage.getItem(LOCAL_DENSITY_KEY) === "compact";
  } catch (e) {
    return false;
  }
}

function saveDensitySetting(compact) {
  try {
    localStorage.setItem(LOCAL_DENSITY_KEY, compact ? "compact" : "comfortable");
  } catch (e) {}
}

function loadLocalFlags() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_FLAGS_KEY) || "{}");
  } catch (e) {
    return {};
  }
}

function saveLocalFlags(flags) {
  try {
    localStorage.setItem(LOCAL_FLAGS_KEY, JSON.stringify(flags));
  } catch (e) {}
}

function openModal({ title, content }) {
  const overlay = $("modalOverlay");
  const modalTitle = $("modalTitle");
  const modalBody = $("modalBody");
  if (!overlay || !modalTitle || !modalBody) return;
  modalTitle.textContent = title || "Modal";
  modalBody.innerHTML = content || "";
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

function viewTemplate() {
  return {
    overview: `
      <section class="viewSection overviewSection">
        <div class="kpiGrid">
          <div class="kpiCard">
            <div class="kpiLabel">MRR Estimate</div>
            <div class="kpiValue" id="kpiMrr">--</div>
          </div>
          <div class="kpiCard">
            <div class="kpiLabel">Active Companies</div>
            <div class="kpiValue" id="kpiActiveOrgs">--</div>
          </div>
          <div class="kpiCard">
            <div class="kpiLabel">Onboarded Vehicles</div>
            <div class="kpiValue" id="kpiActiveFleets">--</div>
          </div>
          <div class="kpiCard">
            <div class="kpiLabel">Open Pipeline</div>
            <div class="kpiValue" id="kpiOpenLeads">--</div>
            <div class="muted" style="margin-top:6px; font-size:12px;">Leads awaiting action.</div>
          </div>
        </div>
        <div class="overviewGrid">
        <div class="panelCard">
          <div class="panelHeader">
            <h2>Onboarding activity</h2>
            <span class="panelMeta">Latest account changes</span>
          </div>
          <div class="panelBody" id="activityFeed">
            <div class="emptyState">No recent activity.</div>
          </div>
        </div>
        <div class="panelCard">
          <div class="panelHeader">
            <h2>Service exceptions</h2>
            <span class="panelMeta">Items needing review</span>
          </div>
          <div class="panelBody" id="recentAlertsFeed">
            <div class="emptyState">No alerts yet.</div>
          </div>
        </div>
        </div>
      </section>
    `,
    orgs: `
      <section class="viewSection">
        <div class="sectionHeaderRow">
          <div>
            <h2>Companies</h2>
            <p class="muted">Create, review, and move companies from pilot setup to active customer.</p>
          </div>
          <div class="headerActions">
            <input type="search" id="orgSearch" placeholder="Search companies" />
            <button class="btn primary" id="orgCreateBtn" type="button">Create Company</button>
          </div>
        </div>
        <div class="orgLayout">
          <div class="panelCard">
            <div class="panelHeader">
              <h3>Customer accounts</h3>
              <span class="panelMeta">Select a row to manage the account</span>
            </div>
            <div class="panelBody">
              <label class="muted" style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
                <input type="checkbox" id="orgShowDeleted" />
                Show deleted organizations
              </label>
              <div class="tableWrap">
                <table class="dataTable">
                  <thead>
                    <tr>
                      <th>Org name</th>
                      <th>Status</th>
                      <th>Fleet size</th>
                      <th>Active vehicles</th>
                      <th>Primary contact</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody id="orgTable"></tbody>
                </table>
              </div>
              <div class="emptyState" id="orgEmpty" style="display:none;">No organizations available.</div>
            </div>
          </div>
          <div class="panelCard" id="orgDetailPanel">
            <div class="panelHeader">
              <h3>Company workspace</h3>
              <span class="panelMeta" id="orgDetailMeta">Select a company to begin</span>
            </div>
            <div class="panelBody">
              <div class="detailForm">
                <label class="fieldGroup">
                  <span>Organization name</span>
                  <input id="orgDetailNameInput" type="text" />
                </label>
                <label class="fieldGroup">
                  <span>Status</span>
                  <select id="orgDetailStatusSelect">
                    <option value="LEAD">Lead</option>
                    <option value="PILOT">Pilot</option>
                    <option value="ACTIVE">Active</option>
                    <option value="PAUSED">Paused</option>
                    <option value="CHURNED">Churned</option>
                  </select>
                </label>
                <label class="fieldGroup">
                  <span>Primary contact name</span>
                  <input id="orgDetailContactName" type="text" />
                </label>
                <label class="fieldGroup">
                  <span>Primary contact email</span>
                  <input id="orgDetailContactEmail" type="email" />
                </label>
                <label class="fieldGroup">
                  <span>Primary contact phone</span>
                  <input id="orgDetailPhone" type="text" />
                </label>
                <label class="fieldGroup">
                  <span>Fleet size estimate</span>
                  <input id="orgDetailFleetSize" type="number" min="0" />
                </label>
                <label class="fieldGroup">
                  <span>Active vehicles</span>
                  <input id="orgDetailActiveVehicles" type="number" min="0" />
                </label>
                <label class="fieldGroup">
                  <span>Billing plan</span>
                  <select id="orgDetailPlanSelect">
                    <option value="PILOT_CORE">Pilot: $50/vehicle/month</option>
                    <option value="CORE_STANDARD">Standard (Contact Sales)</option>
                  </select>
                </label>
                <label class="fieldGroup">
                  <span>Notes</span>
                  <textarea id="orgDetailNotesInput" rows="4"></textarea>
                </label>
              </div>
              <div class="detailActions">
                <button class="btn primary" id="orgSaveBtn" type="button">Save Organization</button>
                <div class="muted" id="orgSaveNote">Select an organization to edit.</div>
              </div>
              <div class="panelCard" style="margin-top:12px;">
                <div class="panelHeader">
                  <h3>Customer access</h3>
                  <span class="panelMeta">Issue or repair the primary contact login</span>
                </div>
                <div class="panelBody">
                  <label class="fieldGroup">
                    <span>Customer email</span>
                    <input id="orgCustomerEmail" type="email" />
                  </label>
                  <div class="detailActions">
                    <button class="btn primary" id="orgCreateCustomerBtn" type="button">Create Customer Login</button>
                    <button class="btn secondary" id="orgResetCustomerBtn" type="button">Reset Temporary Password</button>
                  </div>
                  <div class="detailBlock">
                    <div class="detailLabel">Customer login</div>
                    <div class="detailValue"><a href="/customer-login.html" target="_blank" rel="noreferrer">/customer-login.html</a></div>
                  </div>
                  <div class="detailBlock" id="customerPasswordBlock" style="display:none;">
                    <div class="detailLabel">One-time temporary password</div>
                    <div class="detailValue" id="customerTempPassword">--</div>
                    <div class="muted" style="font-size:12px;">Store this securely before leaving the page. It cannot be shown again.</div>
                    <div class="credentialActions">
                      <button class="btn primary" id="customerCopyPasswordBtn" type="button">Copy password</button>
                      <a class="btn ghost" href="/customer-login.html" target="_blank" rel="noreferrer">Open customer login</a>
                    </div>
                  </div>
                </div>
              </div>
              <div class="panelCard" style="margin-top:12px;" id="orgFleetPanel">
                <div class="panelHeader">
                  <h3>Connected fleet <span id="orgFleetCount" class="panelMeta" style="margin-left:6px;"></span></h3>
                  <button class="btn ghost" id="orgFleetRefreshBtn" type="button" style="font-size:11px;">Refresh</button>
                </div>
                <div id="orgFleetBody">
                  <div class="emptyState" style="border-radius:0 0 10px 10px;">Select an organization to view its fleet.</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    `,
    leads: `
      <section class="viewSection">
        <div class="sectionHeaderRow">
          <div>
            <h2>Leads &amp; Demos</h2>
            <p class="muted">Inbound demo and pilot requests.</p>
          </div>
          <div class="filterTabs" id="leadFilters">
            <button type="button" data-status="ALL" class="is-active">All</button>
            <button type="button" data-status="NEW">New</button>
            <button type="button" data-status="CONTACTED">Contacted</button>
            <button type="button" data-status="SCHEDULED">Scheduled</button>
            <button type="button" data-status="CONVERTED">Converted</button>
            <button type="button" data-status="CLOSED">Closed</button>
          </div>
        </div>
        <div class="leadLayout">
          <div class="panelCard">
            <div class="panelHeader">
              <h3>Pipeline</h3>
              <span class="panelMeta">Most recent first</span>
            </div>
            <div class="panelBody">
              <div class="tableWrap">
                <table class="dataTable">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Company</th>
                      <th>Contact</th>
                      <th>Email</th>
                      <th>Status</th>
                      <th>Created</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody id="leadTable"></tbody>
                </table>
              </div>
              <div class="emptyState" id="leadEmpty">No leads captured yet.</div>
            </div>
          </div>
          <div class="panelCard" id="leadDetailPanel">
            <div class="panelHeader">
              <h3>Lead Detail</h3>
              <span class="panelMeta" id="leadDetailMeta">Select a lead to view.</span>
            </div>
            <div class="panelBody">
              <div class="detailGrid">
                <div class="detailBlock">
                  <div class="detailLabel">Company</div>
                  <div class="detailValue" id="leadDetailCompany">--</div>
                </div>
                <div class="detailBlock">
                  <div class="detailLabel">Contact</div>
                  <div class="detailValue" id="leadDetailContact">--</div>
                </div>
                <div class="detailBlock">
                  <div class="detailLabel">Email</div>
                  <div class="detailValue" id="leadDetailEmail">--</div>
                </div>
                <div class="detailBlock">
                  <div class="detailLabel">Phone</div>
                  <div class="detailValue" id="leadDetailPhone">--</div>
                </div>
                <div class="detailBlock">
                  <div class="detailLabel">Lead type</div>
                  <div class="detailValue" id="leadDetailType">--</div>
                </div>
                <div class="detailBlock">
                  <div class="detailLabel">Fleet size</div>
                  <div class="detailValue" id="leadDetailFleet">--</div>
                </div>
                <div class="detailBlock">
                  <div class="detailLabel">Message</div>
                  <div class="detailValue" id="leadDetailMessage">--</div>
                </div>
                <div class="detailBlock">
                  <div class="detailLabel">Source</div>
                  <div class="detailValue" id="leadDetailSource">--</div>
                </div>
                <div class="detailBlock">
                  <div class="detailLabel">Submitted</div>
                  <div class="detailValue" id="leadDetailCreated">--</div>
                </div>
              </div>
              <div class="detailForm">
                <label class="fieldGroup">
                  <span>Status</span>
                  <select id="leadStatusSelect">
                    <option value="NEW">New</option>
                    <option value="CONTACTED">Contacted</option>
                    <option value="SCHEDULED">Scheduled</option>
                    <option value="CONVERTED">Converted</option>
                    <option value="CLOSED">Closed</option>
                  </select>
                </label>
                <label class="fieldGroup">
                  <span>Internal notes</span>
                  <textarea id="leadInternalNotes" rows="4" placeholder="Add internal notes"></textarea>
                </label>
              </div>
              <div class="detailActions">
                <button class="btn primary" id="leadSaveBtn" type="button">Save Lead</button>
                <button class="btn secondary" id="leadConvertBtn" type="button">Convert to Organization</button>
                <div class="muted" id="leadSaveNote">Select a lead to view details.</div>
              </div>
            </div>
          </div>
        </div>
      </section>
    `
  };
}
function viewTemplateExtended() {
  return {
    invites: `
      <section class="viewSection">
        <div class="sectionHeaderRow">
          <div>
            <h2>Access invitations</h2>
            <p class="muted">Issue time-limited setup links for customer administrators.</p>
          </div>
        </div>
        <div class="panelCard">
          <div class="panelHeader">
            <h3>Issue an invitation</h3>
            <span class="panelMeta">Secure customer setup</span>
          </div>
          <div class="panelBody">
            <div class="formGrid">
              <label class="fieldGroup">
                <span>Organization</span>
                <select id="inviteOrgSelect"></select>
              </label>
              <label class="fieldGroup">
                <span>Invite type</span>
                <select id="inviteTypeSelect">
                  <option value="CUSTOMER">Customer login</option>
                </select>
              </label>
              <button class="btn primary" id="inviteCreateBtn" type="button">Generate Invite Link</button>
              <div class="detailBlock" id="inviteResult" style="display:none;">
                <div class="detailLabel">Invite link</div>
                <div class="detailValue" id="inviteResultUrl">--</div>
              </div>
            </div>
          </div>
        </div>
        <div class="panelCard">
          <div class="panelHeader">
            <h3>Open invitations</h3>
            <span class="panelMeta">Links expire automatically</span>
          </div>
          <div class="panelBody">
            <div class="tableWrap">
              <table class="dataTable">
                <thead>
                  <tr>
                    <th>Org</th>
                    <th>Type</th>
                    <th>Expires</th>
                    <th>Link</th>
                  </tr>
                </thead>
                <tbody id="inviteTable"></tbody>
              </table>
            </div>
            <div class="emptyState" id="inviteEmpty">No active invites.</div>
          </div>
        </div>
      </section>
    `,
    billing: `
      <section class="viewSection">
        <div class="sectionHeaderRow">
          <div>
            <h2>Billing setup</h2>
            <p class="muted">Review account contacts, plan assignment, and payment readiness.</p>
          </div>
        </div>
        <div class="billingLayout">
          <div class="panelCard">
            <div class="panelHeader">
              <h3>Account billing profile</h3>
              <span class="panelMeta">Internal preparation workspace</span>
            </div>
            <div class="panelBody">
              <div class="formGrid twoCol">
                <label class="fieldGroup">
                  <span>Organization</span>
                  <select id="billingOrgSelect"></select>
                </label>
                <label class="fieldGroup">
                  <span>Plan (Pilot: $50/vehicle/month)</span>
                  <input id="billingPlanDisplay" type="text" disabled />
                </label>
                <label class="fieldGroup">
                  <span>Billing contact name</span>
                  <input id="billingContactName" type="text" />
                </label>
                <label class="fieldGroup">
                  <span>Billing email</span>
                  <input id="billingEmail" type="email" />
                </label>
                <label class="fieldGroup">
                  <span>Payment method</span>
                  <select id="billingMethod">
                    <option value="CARD">Card</option>
                    <option value="ACH">ACH</option>
                  </select>
                </label>
              </div>
              <div class="formGrid twoCol" id="billingCardFields">
                <label class="fieldGroup">
                  <span>Card number (last 4)</span>
                  <input id="billingCardNumber" type="text" inputmode="numeric" placeholder="1234" />
                </label>
                <label class="fieldGroup">
                  <span>Exp date</span>
                  <div class="inlineFields">
                    <input id="billingExpMonth" type="text" inputmode="numeric" placeholder="MM" />
                    <input id="billingExpYear" type="text" inputmode="numeric" placeholder="YYYY" />
                  </div>
                </label>
                <label class="fieldGroup">
                  <span>CVC</span>
                  <input id="billingCvc" type="password" inputmode="numeric" placeholder="CVC" />
                </label>
              </div>
              <div class="formGrid twoCol" id="billingAchFields" style="display:none;">
                <label class="fieldGroup">
                  <span>Routing number</span>
                  <input id="billingRouting" type="text" inputmode="numeric" />
                </label>
                <label class="fieldGroup">
                  <span>Account number</span>
                  <input id="billingAccount" type="password" inputmode="numeric" />
                </label>
              </div>
              <div class="detailActions">
                <button class="btn primary" id="billingSaveBtn" type="button">Save Billing Profile</button>
                <div class="muted" id="billingSaveNote">Select an organization to edit billing.</div>
              </div>
            </div>
          </div>
          <div class="panelCard billingSummary">
            <div class="panelHeader">
              <h3>Plan Summary</h3>
              <span class="panelMeta">Pilot pricing</span>
            </div>
            <div class="panelBody">
              <div class="detailBlock">
                <div class="detailLabel">Pilot plan</div>
                <div class="detailValue">Pilot: $50/vehicle/month</div>
              </div>
              <div class="detailBlock">
                <div class="detailLabel">Billing cadence</div>
                <div class="detailValue">Monthly per active vehicle</div>
              </div>
              <div class="detailBlock">
                <div class="detailLabel">Test mode</div>
                <div class="detailValue">Stored locally. No payment processor connected.</div>
              </div>
            </div>
          </div>
        </div>
      </section>
    `,
    features: `
      <section class="viewSection">
        <div class="sectionHeaderRow">
          <div>
            <h2>Product access</h2>
            <p class="muted">Control optional capabilities for each customer workspace.</p>
          </div>
        </div>
        <div class="panelCard">
          <div class="panelHeader">
            <h3>Workspace capabilities</h3>
            <span class="panelMeta" id="flagNotice">Changes save immediately.</span>
          </div>
          <div class="panelBody">
            <label class="fieldGroup">
              <span>Organization</span>
              <select id="flagOrgSelect"></select>
            </label>
            <div class="toggleGrid">
              <label class="toggleSwitch">
                <input type="checkbox" id="flagCamera" />
                <span class="toggleTrack"></span>
                <span class="toggleLabel">Camera Integration</span>
                <span class="toggleNote">Coming soon.</span>
              </label>
              <label class="toggleSwitch">
                <input type="checkbox" id="flagSafety" />
                <span class="toggleTrack"></span>
                <span class="toggleLabel">Safety Score Pack</span>
                <span class="toggleNote">Coming soon.</span>
              </label>
              <label class="toggleSwitch">
                <input type="checkbox" id="flagCompliance" />
                <span class="toggleTrack"></span>
                <span class="toggleLabel">Compliance Pack</span>
                <span class="toggleNote">Coming soon.</span>
              </label>
            </div>
          </div>
        </div>
      </section>
    `,
    "system-health": `
      <section class="viewSection">
        <div class="sectionHeaderRow">
          <div>
            <h2>Service health</h2>
            <p class="muted">Inspect core service availability and route diagnostics.</p>
          </div>
        </div>
        <div class="panelCard">
          <div class="panelHeader">
            <h3>Server</h3>
            <span class="panelMeta">/health</span>
          </div>
          <div class="panelBody">
            <div class="detailGrid">
              <div class="detailBlock">
                <div class="detailLabel">Status</div>
                <div class="detailValue" id="healthStatus">--</div>
              </div>
              <div class="detailBlock">
                <div class="detailLabel">Version</div>
                <div class="detailValue" id="healthVersion">--</div>
              </div>
              <div class="detailBlock">
                <div class="detailLabel">Time</div>
                <div class="detailValue" id="healthTime">--</div>
              </div>
            </div>
          </div>
        </div>
        <div class="panelCard">
          <div class="panelHeader">
            <h3>Diagnostics</h3>
            <span class="panelMeta">/api/diagnostics</span>
          </div>
          <div class="panelBody">
            <div class="detailGrid">
              <div class="detailBlock">
                <div class="detailLabel">Advisor</div>
                <div class="detailValue" id="diagAdvisor">--</div>
              </div>
              <div class="detailBlock">
                <div class="detailLabel">Billing</div>
                <div class="detailValue" id="diagBilling">--</div>
              </div>
              <div class="detailBlock">
                <div class="detailLabel">Pairing</div>
                <div class="detailValue" id="diagPairing">--</div>
              </div>
            </div>
            <div class="tableWrap" style="margin-top:12px;">
              <table class="dataTable">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody id="diagRoutes"></tbody>
              </table>
            </div>
            <div class="emptyState" id="diagRoutesEmpty">No diagnostics available.</div>
          </div>
        </div>
      </section>
    `,
    "audit-log": `
      <section class="viewSection">
        <div class="sectionHeaderRow">
          <div>
            <h2>Activity ledger</h2>
            <p class="muted">Review administrative changes and security-relevant events.</p>
          </div>
        </div>
        <div class="panelCard">
          <div class="panelHeader">
            <h3>Administrative events</h3>
            <span class="panelMeta">Most recent first</span>
          </div>
          <div class="panelBody">
            <div class="tableWrap">
              <table class="dataTable">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody id="auditTable"></tbody>
              </table>
            </div>
            <div class="emptyState" id="auditEmpty">No audit events available.</div>
          </div>
        </div>
      </section>
    `,
    users: `
      <section class="viewSection">
        <div class="sectionHeaderRow">
          <div>
            <h2>Employee access</h2>
            <p class="muted">Manage internal users and operational permissions.</p>
          </div>
          <button class="btn primary" id="employeeCreateBtn" type="button">Add Employee</button>
        </div>
        <div class="panelCard">
          <div class="panelHeader">
            <h3>Employee directory</h3>
            <span class="panelMeta">Internal staff only</span>
          </div>
          <div class="panelBody">
            <div class="tableWrap">
              <table class="dataTable">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Created</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody id="userTable"></tbody>
              </table>
            </div>
            <div class="emptyState" id="userEmpty" style="display:none;">No employees available.</div>
          </div>
        </div>
      </section>
    `,
    settings: `
      <section class="viewSection">
        <div class="sectionHeader">
          <h2>Console settings</h2>
          <p class="muted">Adjust this employee workspace without changing customer accounts.</p>
        </div>
        <div class="panelCard">
          <div class="panelHeader">
            <h3>Display preferences</h3>
            <span class="panelMeta">Local to this browser</span>
          </div>
          <div class="panelBody">
            <div class="formGrid">
              <label class="fieldGroup">
                <span>Theme</span>
                <select id="portalThemeSelect">
                  <option value="light-blue">Light</option>
                  <option value="dark-blue">Dark Blue</option>
                  <option value="dark-gray">Dark Gray</option>
                </select>
              </label>
              <label class="toggleSwitch">
                <input type="checkbox" id="densityToggle" />
                <span class="toggleTrack"></span>
                <span class="toggleLabel">Compact density</span>
              </label>
            </div>
          </div>
        </div>
      </section>
    `,
    "api-keys": `
      <section class="viewSection">
        <div class="sectionHeaderRow">
          <div>
            <h2>Partner API Keys</h2>
            <p class="muted">Issue and revoke partner_ml API keys. The raw key is shown only once at creation — save it immediately.</p>
          </div>
        </div>
        <div class="panelCard">
          <div class="panelHeader">
            <h3>Create API Key</h3>
            <span class="panelMeta">Super Admin only</span>
          </div>
          <div class="panelBody">
            <div class="formGrid twoCol">
              <label class="fieldGroup">
                <span>Partner name <span style="color:#e53e3e">*</span></span>
                <input type="text" id="apiKeyPartner" placeholder="e.g. sentinelx or geotab" maxlength="80" />
              </label>
              <label class="fieldGroup">
                <span>Tier</span>
                <select id="apiKeyTier">
                  <option value="partner_ml">partner_ml — full prediction + stream + widget</option>
                  <option value="standard">standard — basic access</option>
                </select>
              </label>
              <label class="fieldGroup">
                <span>Org ID (optional)</span>
                <input type="text" id="apiKeyOrgId" placeholder="ORG_DEFAULT (leave blank if not tied to an org)" maxlength="80" />
              </label>
              <button class="btn primary" id="apiKeyCreateBtn" type="button">Generate API Key</button>
            </div>
            <div id="apiKeyResult" style="display:none;margin-top:16px;padding:14px 16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
              <div style="font-size:12px;font-weight:600;color:#166534;margin-bottom:6px">API Key generated — copy it now, it won't be shown again</div>
              <code id="apiKeyRawValue" style="font-family:ui-monospace,monospace;font-size:13px;word-break:break-all;color:#166534"></code>
              <button class="btn ghost" id="apiKeyCopyBtn" type="button" style="margin-top:10px;font-size:12px">Copy to clipboard</button>
            </div>
          </div>
        </div>
        <div class="panelCard">
          <div class="panelHeader">
            <h3>Active Keys</h3>
            <span class="panelMeta" id="apiKeyCount">Loading...</span>
          </div>
          <div class="panelBody">
            <div class="tableWrap">
              <table class="dataTable">
                <thead>
                  <tr>
                    <th>Partner</th>
                    <th>Tier</th>
                    <th>Org</th>
                    <th>Last Used</th>
                    <th>Created</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="apiKeyTable"></tbody>
              </table>
            </div>
            <div class="emptyState" id="apiKeyEmpty" style="display:none">No API keys yet.</div>
          </div>
        </div>
      </section>
    `
  };
}

function renderView(route) {
  const view = $("portalView");
  if (!view) return;
  const templates = Object.assign({}, viewTemplate(), viewTemplateExtended());
  const template = templates[route] || templates.overview;
  adminState.currentRoute = route;
  view.innerHTML = template;
  setActiveRoute(route);
  bindView(route);
  renderPortalError();
}
function setActiveRoute(route) {
  document.querySelectorAll("#employeeNav button").forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-route") === route);
  });
  const titles = {
    overview: ["Operations", "Customer activation, fleet adoption, and priority exceptions in one view."],
    orgs: ["Companies", "Create customer accounts, issue access, and review connected fleets."],
    leads: ["Sales pipeline", "Qualify inbound requests and convert approved pilots into customer accounts."],
    invites: ["Access invitations", "Issue time-limited setup links for customer administrators."],
    billing: ["Billing setup", "Prepare plan, contact, and payment metadata for each account."],
    features: ["Product access", "Control optional capabilities by customer workspace."],
    "system-health": ["Service health", "Inspect core service availability and backend route checks."],
    "audit-log": ["Activity ledger", "Review administrative and security-relevant changes."],
    users: ["Employee access", "Manage internal users and operational permissions."],
    settings: ["Console settings", "Adjust local display preferences for this workspace."],
    "api-keys": ["Partner API", "Issue and revoke scoped keys for approved Fleet AI integrations."]
  };
  if (titles[route]) {
    setViewTitle(titles[route][0], titles[route][1]);
  }
}

async function loadMe() {
  try {
    const session = await apiJson("/api/employee/session");
    if (!session) return;
    adminState.role = session.employee?.role || "";
    const roleEl = $("portalRole");
    if (roleEl) roleEl.textContent = `Role: ${adminState.role || "--"}`;
    updateConsoleDebug({ whoami: "ok", authType: "cookie" });
  } catch (err) {
    const message = err && err.message ? err.message : "Unable to load session.";
    setPortalError(message);
    updateConsoleDebug({ whoami: "failed", authType: "cookie" });
    const roleEl = $("portalRole");
    if (roleEl) roleEl.textContent = "Role: --";
  }
}

function applyRoleState() {
  const orgCreateBtn = $("orgCreateBtn");
  if (orgCreateBtn) orgCreateBtn.disabled = !roleAllowsOrgEdit();
  const orgSaveBtn = $("orgSaveBtn");
  if (orgSaveBtn) orgSaveBtn.disabled = !roleAllowsOrgEdit();
  const orgCreateCustomerBtn = $("orgCreateCustomerBtn");
  if (orgCreateCustomerBtn) orgCreateCustomerBtn.disabled = !roleAllowsOrgEdit();
  const orgResetCustomerBtn = $("orgResetCustomerBtn");
  if (orgResetCustomerBtn) orgResetCustomerBtn.disabled = !roleAllowsOrgEdit();
  const leadSaveBtn = $("leadSaveBtn");
  if (leadSaveBtn) leadSaveBtn.disabled = !roleAllowsLeadEdit();
  const leadConvertBtn = $("leadConvertBtn");
  if (leadConvertBtn) leadConvertBtn.disabled = !roleAllowsLeadConvert();
  const inviteCreateBtn = $("inviteCreateBtn");
  if (inviteCreateBtn) inviteCreateBtn.disabled = !roleAllowsOrgEdit();
  const employeeCreateBtn = $("employeeCreateBtn");
  if (employeeCreateBtn) employeeCreateBtn.disabled = !roleAllowsEmployeeEdit();
}

async function loadOverview() {
  try {
    const data = await apiJson("/api/overview");
    if (!data) return;
    $("kpiMrr").textContent = data.data.mrrEstimate ?? "--";
    $("kpiActiveOrgs").textContent = data.data.activeOrgs ?? "--";
    $("kpiActiveFleets").textContent = data.data.activeVehicles ?? "--";
    $("kpiOpenLeads").textContent = data.data.openLeads ?? "--";
    renderRecentAlerts(data.data.recentAlerts || []);
  } catch (e) {
    $("kpiMrr").textContent = "--";
    $("kpiActiveOrgs").textContent = "--";
    $("kpiActiveFleets").textContent = "--";
    $("kpiOpenLeads").textContent = "--";
    renderRecentAlerts([]);
  }
}

function renderRecentAlerts(alerts) {
  const feed = $("recentAlertsFeed");
  if (!feed) return;
  if (!alerts.length) {
    feed.innerHTML = `<div class="emptyState">No alerts yet.</div>`;
    return;
  }
  feed.innerHTML = alerts
    .slice(0, 6)
    .map(
      (alert) => `
      <div class="detailBlock">
        <div class="detailLabel">${formatDateTime(alert.createdAt || alert.ts)}</div>
        <div class="detailValue"><strong>${alert.type || "Alert"}</strong> ${alert.vehicleId || ""}</div>
        <div class="muted" style="margin-top:4px;">${alert.explanation || ""}</div>
      </div>
    `
    )
    .join("");
}

async function loadAudit() {
  try {
    const data = await apiJson("/api/audit");
    if (!data) return;
    adminState.audit = data.data || [];
    renderActivity();
    renderAuditLog();
  } catch (e) {
    adminState.audit = [];
    renderActivity();
    renderAuditLog();
  }
}

function renderActivity() {
  const feed = $("activityFeed");
  if (!feed) return;
  if (!adminState.audit.length) {
    feed.innerHTML = `<div class="emptyState">No recent activity.</div>`;
    return;
  }
  feed.innerHTML = adminState.audit
    .slice(0, 8)
    .map(
      (entry) => `
      <div class="detailBlock">
        <div class="detailLabel">${formatDateTime(entry.createdAt || entry.ts)}</div>
        <div class="detailValue"><strong>${entry.event}</strong> ${entry.detail || ""}</div>
      </div>
    `
    )
    .join("");
}

function renderAuditLog() {
  const body = $("auditTable");
  const empty = $("auditEmpty");
  if (!body) return;
  if (!adminState.audit.length) {
    body.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";
  body.innerHTML = adminState.audit
    .map(
      (entry) => `
        <tr>
          <td>${formatDateTime(entry.createdAt || entry.ts)}</td>
          <td>${entry.event || "--"}</td>
          <td>${entry.detail || "--"}</td>
        </tr>`
    )
    .join("");
}

async function loadSystemHealth() {
  const statusEl = $("healthStatus");
  const versionEl = $("healthVersion");
  const timeEl = $("healthTime");
  try {
    const res = await fetch(resolveApiUrl("/api/health"));
    const data = await res.json();
    if (statusEl) statusEl.textContent = data.ok ? "Online" : "Degraded";
    if (versionEl) versionEl.textContent = data.version || "--";
    if (timeEl) timeEl.textContent = data.time || "--";
  } catch (e) {
    if (statusEl) statusEl.textContent = "Offline";
  }
  try {
    const diag = await apiJson("/api/diagnostics");
    const advisor = $("diagAdvisor");
    const billing = $("diagBilling");
    const pairing = $("diagPairing");
    if (advisor) advisor.textContent = diag?.modules?.advisor ? "Enabled" : "Unavailable";
    if (billing) billing.textContent = diag?.modules?.billing ? "Enabled" : "Unavailable";
    if (pairing) pairing.textContent = diag?.modules?.pairing ? "Enabled" : "Unavailable";
    const routes = diag?.routes || [];
    const tbody = $("diagRoutes");
    const empty = $("diagRoutesEmpty");
    if (tbody) {
      if (!routes.length) {
        tbody.innerHTML = "";
        if (empty) empty.style.display = "block";
      } else {
        if (empty) empty.style.display = "none";
        tbody.innerHTML = routes
          .map(
            (route) => `
            <tr>
              <td>${route.method}</td>
              <td>${route.path}</td>
              <td>${route.available ? "OK" : "Missing"}</td>
            </tr>`
          )
          .join("");
      }
    }
  } catch (e) {
    const tbody = $("diagRoutes");
    if (tbody) tbody.innerHTML = "";
  }
}

function getOrgById(orgId) {
  return adminState.orgs.find((item) => (item.orgId || item.id) === orgId);
}

async function loadOrgs() {
  const includeDeleted = adminState.showDeletedOrgs ? "?includeDeleted=1" : "";
  const data = await apiJson(`/api/orgs${includeDeleted}`);
  if (!data) return;
  adminState.orgs = data.data || [];
  renderOrgs();
  populateOrgSelects();
}

function renderOrgs() {
  const body = $("orgTable");
  const empty = $("orgEmpty");
  if (!body) return;
  const term = $("orgSearch")?.value?.trim().toLowerCase() || "";
  const orgs = term
    ? adminState.orgs.filter((org) => (org.name || "").toLowerCase().includes(term))
    : adminState.orgs;
  if (!orgs.length) {
    body.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";
  body.innerHTML = orgs
    .map((org) => {
      const orgId = org.orgId || org.id;
      const disableDelete = !roleAllowsOrgEdit() || String(org.status || "").toUpperCase() === "DELETED";
      const recoveryTag = org.duplicateOf
        ? `<span class="statusBadge status-duplicate">Duplicate</span>`
        : (org.recoveredFromAuthStore ? `<span class="statusBadge status-recovered">Recovered</span>` : "");
      return `
        <tr data-org-id="${orgId}">
          <td><div class="companyCell"><strong>${org.name || "--"}</strong>${recoveryTag}</div></td>
          <td><span class="statusBadge status-${(org.status || "LEAD").toLowerCase()}">${formatStatus(org.status)}</span></td>
          <td>${Number(org.fleetSizeEstimate || 0)}</td>
          <td>${Number(org.activeVehicles || 0)}</td>
          <td class="contactCell" title="${org.primaryContactEmail || ""}">${org.primaryContactEmail || "--"}</td>
          <td>
            <div class="rightStack">
              <button class="btn ghost" data-action="view-org" data-org-id="${orgId}">Open</button>
              <button class="btn ghost" data-action="delete-org" data-org-id="${orgId}" ${disableDelete ? "disabled" : ""}>Delete</button>
            </div>
          </td>
        </tr>`;
    })
    .join("");
}

function confirmOrgDelete(org) {
  if (!org) return;
  openModal({
    title: "Delete Organization",
    content: `<div class="detailBlock">
      <div class="detailLabel">Organization</div>
      <div class="detailValue">${org.name || org.orgId || org.id}</div>
    </div>
    <div class="muted" style="margin:12px 0;">Type DELETE to confirm. This is a soft delete.</div>
    <div class="fieldGroup">
      <span>Confirmation</span>
      <input id="orgDeleteConfirmInput" placeholder="Type DELETE" />
    </div>
    <div class="detailActions" style="margin-top:12px;">
      <button class="btn ghost" id="orgDeleteCancelBtn" type="button">Cancel</button>
      <button class="btn" id="orgDeleteConfirmBtn" type="button" disabled>Delete Organization</button>
    </div>`
  });
  const input = $("orgDeleteConfirmInput");
  const confirmBtn = $("orgDeleteConfirmBtn");
  const cancelBtn = $("orgDeleteCancelBtn");
  if (input && confirmBtn) {
    input.addEventListener("input", () => {
      confirmBtn.disabled = input.value.trim().toUpperCase() !== "DELETE";
    });
  }
  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
  if (confirmBtn) {
    confirmBtn.addEventListener("click", async () => {
      try {
        await apiJson(`/api/orgs/${encodeURIComponent(org.orgId || org.id)}`, { method: "DELETE" });
        closeModal();
        adminState.selectedOrgId = null;
        await loadOrgs();
        selectOrg(null);
      } catch (err) {
        alert(err.message || "Unable to delete organization.");
      }
    });
  }
}

function selectOrg(orgId) {
  const org = getOrgById(orgId);
  adminState.selectedOrgId = org ? (org.orgId || org.id) : null;
  const note = $("orgSaveNote");
  const meta = $("orgDetailMeta");
  const saveBtn = $("orgSaveBtn");
  const createBtn = $("orgCreateCustomerBtn");
  const resetBtn = $("orgResetCustomerBtn");
  if (!org) {
    if (note) note.textContent = "Select an organization to edit.";
    if (meta) meta.textContent = "Select an org to view.";
    fillOrgForm(null);
    setOrgFormEnabled(false);
    if (saveBtn) saveBtn.disabled = true;
    if (createBtn) createBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
    loadOrgFleet(null);
    return;
  }
  if (note) note.textContent = roleAllowsOrgEdit() ? "Changes apply immediately." : "Read-only access.";
  if (meta) meta.textContent = `Org ID: ${org.orgId || org.id}`;
  fillOrgForm(org);
  setOrgFormEnabled(roleAllowsOrgEdit());
  if (saveBtn) saveBtn.disabled = !roleAllowsOrgEdit();
  if (createBtn) createBtn.disabled = !roleAllowsOrgEdit();
  if (resetBtn) resetBtn.disabled = !roleAllowsOrgEdit();
  loadOrgFleet(org.orgId || org.id);
}

async function loadOrgFleet(orgId) {
  const body = $("orgFleetBody");
  const count = $("orgFleetCount");
  if (!body) return;
  if (!orgId) {
    body.innerHTML = `<div class="emptyState" style="border-radius:0 0 10px 10px;">Select an organization to view its fleet.</div>`;
    if (count) count.textContent = "";
    return;
  }
  body.innerHTML = `<div class="emptyState" style="border-radius:0 0 10px 10px;">Loading fleet…</div>`;
  try {
    const data = await apiJson(`/api/orgs/${encodeURIComponent(orgId)}/vehicles`);
    const vehicles = (data && data.data) ? data.data : (Array.isArray(data) ? data : []);
    if (count) count.textContent = vehicles.length ? `— ${vehicles.length} vehicle${vehicles.length !== 1 ? "s" : ""}` : "";
    renderOrgFleet(vehicles);
  } catch (err) {
    body.innerHTML = `<div class="emptyState" style="border-radius:0 0 10px 10px;">Could not load fleet: ${err.message || "unknown error"}</div>`;
    if (count) count.textContent = "";
  }
}

function renderOrgFleet(vehicles) {
  const body = $("orgFleetBody");
  if (!body) return;
  if (!vehicles.length) {
    body.innerHTML = `<div class="emptyState" style="border-radius:0 0 10px 10px;">No vehicles added to this organization yet.</div>`;
    return;
  }
  const rows = vehicles.map((v) => {
    const name = v.unitName || v.number || "--";
    const vin = v.vin ? v.vin.slice(-8) : "--";
    const type = v.type || "--";
    const ymm = [v.year, v.make, v.model].filter(Boolean).join(" ") || "--";
    const active = v.isActive !== false;
    const gatewayDot = v.motiveGatewayConnected === false
      ? `<span title="Gateway disconnected" style="color:#ef4444;">●</span> `
      : (v.motiveId ? `<span title="Motive connected" style="color:#22c55e;">●</span> ` : "");
    return `<tr>
      <td><strong>${gatewayDot}${name}</strong></td>
      <td class="muted" title="${v.vin || ""}">…${vin}</td>
      <td>${type}</td>
      <td class="muted">${ymm}</td>
      <td><span class="statusBadge status-${active ? "active" : "paused"}">${active ? "Active" : "Off"}</span></td>
    </tr>`;
  }).join("");
  body.innerHTML = `
    <div class="tableWrap" style="max-height:260px; overflow:auto; border-radius:0 0 10px 10px; border:0;">
      <table class="dataTable" style="min-width:340px;">
        <thead>
          <tr>
            <th>Unit</th>
            <th>VIN (last 8)</th>
            <th>Type</th>
            <th>Year/Make/Model</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function fillOrgForm(org) {
  const set = (id, val) => { const el = $(id); if (el) el.value = val; };
  set("orgDetailNameInput", org?.name || "");
  set("orgDetailStatusSelect", org?.status || "LEAD");
  set("orgDetailContactName", org?.primaryContactName || "");
  set("orgDetailContactEmail", org?.primaryContactEmail || "");
  set("orgDetailPhone", org?.phone || "");
  set("orgDetailFleetSize", org?.fleetSizeEstimate ?? "");
  set("orgDetailActiveVehicles", org?.activeVehicles ?? "");
  set("orgDetailPlanSelect", org?.billingPlan || "PILOT_CORE");
  set("orgDetailNotesInput", org?.notes || "");
  set("orgCustomerEmail", org?.primaryContactEmail || "");
}

function setOrgFormEnabled(enabled) {
  [
    "orgDetailNameInput",
    "orgDetailStatusSelect",
    "orgDetailContactName",
    "orgDetailContactEmail",
    "orgDetailPhone",
    "orgDetailFleetSize",
    "orgDetailActiveVehicles",
    "orgDetailPlanSelect",
    "orgDetailNotesInput",
    "orgCustomerEmail"
  ].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !enabled;
  });
}

async function saveOrg() {
  if (!roleAllowsOrgEdit()) return;
  const orgId = adminState.selectedOrgId;
  if (!orgId) return;
  const payload = {
    name: $("orgDetailNameInput").value.trim(),
    status: $("orgDetailStatusSelect").value,
    primaryContactName: $("orgDetailContactName").value.trim(),
    primaryContactEmail: $("orgDetailContactEmail").value.trim(),
    phone: $("orgDetailPhone").value.trim(),
    fleetSizeEstimate: $("orgDetailFleetSize").value.trim(),
    activeVehicles: $("orgDetailActiveVehicles").value.trim(),
    billingPlan: $("orgDetailPlanSelect").value,
    notes: $("orgDetailNotesInput").value.trim()
  };
  try {
    await apiJson(`/api/orgs/${encodeURIComponent(orgId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    await loadOrgs();
    selectOrg(orgId);
  } catch (e) {
    alert(e.message || "Unable to save organization.");
  }
}

function bindOrgCreate() {
  const btn = $("orgCreateBtn");
  if (!btn) return;
  if (btn.dataset.bound === "true") return;
  btn.dataset.bound = "true";
  btn.addEventListener("click", () => {
    if (!roleAllowsOrgEdit()) return;
    openModal({
      title: "Create Organization",
      content: `<form id="orgCreateForm" class="formGrid twoCol">
        <label class="fieldGroup">
          <span>Organization name</span>
          <input name="name" required />
        </label>
        <label class="fieldGroup">
          <span>Status</span>
          <select name="status">
            <option value="LEAD">Lead</option>
            <option value="PILOT" selected>Pilot</option>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="CHURNED">Churned</option>
          </select>
        </label>
        <label class="fieldGroup">
          <span>Primary contact name</span>
          <input name="primaryContactName" required />
        </label>
        <label class="fieldGroup">
          <span>Primary contact email</span>
          <input type="email" name="primaryContactEmail" required />
        </label>
        <label class="fieldGroup">
          <span>Primary contact phone</span>
          <input name="phone" />
        </label>
        <label class="fieldGroup">
          <span>Fleet size estimate</span>
          <input type="number" min="0" name="fleetSizeEstimate" />
        </label>
        <label class="fieldGroup">
          <span>Active vehicles</span>
          <input type="number" min="0" name="activeVehicles" value="0" />
        </label>
        <label class="fieldGroup" style="grid-column:1/-1;">
          <span>Notes</span>
          <textarea name="notes" rows="3"></textarea>
        </label>
        <label class="fieldGroup accessChoice" style="grid-column:1/-1;display:flex;flex-direction:row;align-items:flex-start;gap:10px;">
          <input type="checkbox" name="createCustomerLogin" checked style="width:auto;margin-top:3px;" />
          <span><strong>Create customer access now</strong><small>The primary contact receives a one-time temporary password for first login.</small></span>
        </label>
        <button class="btn primary" type="submit" style="grid-column:1/-1;justify-self:start;">Create company</button>
      </form>`
    });
    document.getElementById("orgCreateForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = Object.fromEntries(new FormData(e.target));
      payload.createCustomerLogin = Boolean(e.target.elements.createCustomerLogin?.checked);
      for (const field of ["fleetSizeEstimate", "activeVehicles"]) {
        payload[field] = payload[field] === "" ? 0 : Number(payload[field]);
      }
      let createdOrg = null;
      try {
        const data = await apiJson("/api/orgs", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        createdOrg = data && data.data;
        closeModal();
        await loadOrgs();
        if (createdOrg) {
          selectOrg(createdOrg.orgId || createdOrg.id);
          showToast("Company created successfully.", "good");
        }
      } catch (err) {
        alert(err.message || "Unable to create company.");
        return;
      }

      if (createdOrg && payload.createCustomerLogin) {
        try {
          const customerAccess = await apiJson(`/api/orgs/${encodeURIComponent(createdOrg.orgId || createdOrg.id)}/customer/create`, {
            method: "POST",
            body: JSON.stringify({
              email: payload.primaryContactEmail,
              contactName: payload.primaryContactName
            })
          });
          await applyCustomerAccessResult(customerAccess);
        } catch (err) {
          const note = $("orgSaveNote");
          if (note) {
            note.textContent = `Company created, but customer access failed: ${err.message || "unknown error"}. Use Create Customer Login below to retry.`;
          }
          showToast("Company created, but customer access needs attention.", "bad");
        }
      }
    });
  });
}

async function createCustomerLogin() {
  if (!roleAllowsOrgEdit()) return;
  const orgId = adminState.selectedOrgId;
  if (!orgId) return;
  const email = $("orgCustomerEmail")?.value.trim() || "";
  const contactName = $("orgDetailContactName")?.value.trim() || "";
  try {
    const data = await apiJson(`/api/orgs/${encodeURIComponent(orgId)}/customer/create`, {
      method: "POST",
      body: JSON.stringify({ email, contactName })
    });
    if (data && data.data) {
      await applyCustomerAccessResult(data);
    }
  } catch (e) {
    const existingOrgId = e?.data?.existingOrgId;
    const existingOrgName = e?.data?.existingOrgName;
    if (existingOrgId) {
      await loadOrgs();
      selectOrg(existingOrgId);
      const note = $("orgSaveNote");
      if (note) note.textContent = `This login belongs to ${existingOrgName || existingOrgId}. The original company is now open.`;
      showToast("Opened the company that already owns this login.", "good");
      return;
    }
    showToast(e.message || "Unable to create customer login.", "bad");
  }
}

async function resetCustomerPassword() {
  if (!roleAllowsOrgEdit()) return;
  const orgId = adminState.selectedOrgId;
  if (!orgId) return;
  const email = $("orgCustomerEmail")?.value.trim() || "";
  try {
    const data = await apiJson(`/api/orgs/${encodeURIComponent(orgId)}/customer/reset-password`, {
      method: "POST",
      body: JSON.stringify({ email })
    });
    if (data && data.data) {
      showCustomerTempPassword(data.data.tempPassword);
    }
  } catch (e) {
    alert(e.message || "Unable to reset password.");
  }
}

function showCustomerTempPassword(value) {
  const block = $("customerPasswordBlock");
  const field = $("customerTempPassword");
  if (block && field) {
    field.textContent = value || "--";
    block.style.display = "block";
    block.scrollIntoView({ behavior: "smooth", block: "center" });
    showToast("Temporary password created. Copy it before leaving this page.", "good");
  }
}

async function applyCustomerAccessResult(result) {
  const access = result?.data || {};
  if (access.redirectOrgId) {
    await loadOrgs();
    selectOrg(access.redirectOrgId);
    const note = $("orgSaveNote");
    if (note) {
      note.textContent = `Customer access already belongs to ${access.existingOrgName || access.redirectOrgId}. The original company is now open.`;
    }
    showToast("Existing customer account recovered and opened.", "good");
    return;
  }
  if (access.tempPassword) {
    showCustomerTempPassword(access.tempPassword);
    return;
  }
  const note = $("orgSaveNote");
  if (note) {
    note.textContent = access.repaired
      ? "Customer access was repaired. Use the existing password or reset it below."
      : "Customer access already exists. Use reset if a new temporary password is needed.";
  }
  if (access.repaired) showToast("Customer login storage was repaired.", "good");
}

async function loadLeads() {
  const data = await apiJson("/api/leads");
  if (!data) return;
  adminState.leads = data.data || [];
  renderLeads();
}

function filterLeads() {
  if (adminState.leadFilter === "ALL") return adminState.leads;
  return adminState.leads.filter((lead) => (lead.status || "NEW") === adminState.leadFilter);
}

function renderLeads() {
  const leads = filterLeads();
  const body = $("leadTable");
  const empty = $("leadEmpty");
  if (!body) return;
  if (!leads.length) {
    body.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";
  body.innerHTML = leads
    .map((lead) => {
      const leadId = lead.leadId || lead.id;
      return `
        <tr data-lead-id="${leadId}">
          <td>${formatLeadType(lead.leadType)}</td>
          <td>${lead.companyName || "--"}</td>
          <td>${lead.contactName || "--"}</td>
          <td>${lead.contactEmail || "--"}</td>
          <td><span class="statusBadge status-${(lead.status || "NEW").toLowerCase()}">${formatStatus(lead.status || "NEW")}</span></td>
          <td>${formatDate(lead.createdAt)}</td>
          <td><button class="btn ghost" data-lead-id="${leadId}">View</button></td>
        </tr>`;
    })
    .join("");
}

function selectLead(leadId) {
  const lead = adminState.leads.find((item) => (item.leadId || item.id) === leadId);
  adminState.selectedLeadId = lead ? (lead.leadId || lead.id) : null;
  const note = $("leadSaveNote");
  const meta = $("leadDetailMeta");
  const convertBtn = $("leadConvertBtn");
  if (!lead) {
    if (note) note.textContent = "Select a lead to view details.";
    if (meta) meta.textContent = "Select a lead to view.";
    fillLeadDetail(null);
    setLeadFormEnabled(false);
    if (convertBtn) convertBtn.disabled = true;
    return;
  }
  if (note) note.textContent = roleAllowsLeadEdit() ? "Status updates save immediately." : "Read-only access.";
  if (meta) meta.textContent = `Lead ID: ${lead.leadId || lead.id}`;
  fillLeadDetail(lead);
  setLeadFormEnabled(roleAllowsLeadEdit());
  if (convertBtn) {
    const converted = (lead.status || "").toUpperCase() === "CONVERTED";
    convertBtn.disabled = !roleAllowsLeadConvert() || converted;
    convertBtn.textContent = converted ? "Converted to Organization" : "Convert to Organization";
  }
}

function fillLeadDetail(lead) {
  $("leadDetailCompany").textContent = lead?.companyName || "--";
  $("leadDetailContact").textContent = lead?.contactName || "--";
  $("leadDetailEmail").textContent = lead?.contactEmail || "--";
  $("leadDetailPhone").textContent = lead?.contactPhone || "--";
  $("leadDetailType").textContent = formatLeadType(lead?.leadType || "--");
  $("leadDetailFleet").textContent = lead?.fleetSize || "--";
  $("leadDetailMessage").textContent = lead?.message || "--";
  $("leadDetailSource").textContent = lead?.sourcePage || "--";
  $("leadDetailCreated").textContent = formatDateTime(lead?.createdAt);
  $("leadStatusSelect").value = lead?.status || "NEW";
  $("leadInternalNotes").value = lead?.internalNotes || "";
}

function setLeadFormEnabled(enabled) {
  ["leadStatusSelect", "leadInternalNotes"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !enabled;
  });
}

async function saveLead() {
  if (!roleAllowsLeadEdit()) return;
  const leadId = adminState.selectedLeadId;
  if (!leadId) return;
  const payload = {
    status: $("leadStatusSelect").value,
    internalNotes: $("leadInternalNotes").value.trim()
  };
  try {
    await apiJson(`/api/leads/${encodeURIComponent(leadId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    await loadLeads();
    selectLead(leadId);
  } catch (e) {
    alert(e.message || "Unable to save lead.");
  }
}

async function convertLead() {
  if (!roleAllowsLeadConvert()) return;
  const leadId = adminState.selectedLeadId;
  if (!leadId) return;
  try {
    const data = await apiJson(`/api/leads/${encodeURIComponent(leadId)}/convert`, {
      method: "POST",
      body: JSON.stringify({ status: "PILOT" })
    });
    await loadLeads();
    await loadOrgs();
    if (data && data.data && data.data.org) {
      const orgId = data.data.org.orgId || data.data.org.id;
      window.location.hash = "orgs";
      setTimeout(() => {
        selectOrg(orgId);
        if (data.data.reused) {
          showToast(data.data.recovered
            ? "Recovered the original company and linked this lead to it."
            : "This lead was already converted. Opened the existing company.", "good");
        }
      }, 0);
    }
  } catch (e) {
    alert(e.message || "Unable to convert lead.");
  }
}

function bindLeadFilters() {
  const wrap = $("leadFilters");
  if (!wrap) return;
  if (wrap.dataset.bound === "true") return;
  wrap.dataset.bound = "true";
  wrap.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      wrap.querySelectorAll("button").forEach((el) => el.classList.remove("is-active"));
      btn.classList.add("is-active");
      adminState.leadFilter = btn.getAttribute("data-status") || "ALL";
      renderLeads();
    });
  });
}
async function loadInvites() {
  try {
    const data = await apiJson("/api/invites");
    if (!data) return;
    adminState.invites = data.data || [];
    renderInvites();
  } catch (e) {
    adminState.invites = [];
    renderInvites();
  }
}

function renderInvites() {
  const body = $("inviteTable");
  const empty = $("inviteEmpty");
  if (!body) return;
  if (!adminState.invites.length) {
    body.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";
  body.innerHTML = adminState.invites
    .map((invite) => {
      const link = `/signup.html?token=${encodeURIComponent(invite.token)}`;
      const org = getOrgById(invite.orgId);
      return `
        <tr>
          <td>${org?.name || invite.orgId || "--"}</td>
          <td>${invite.type || "--"}</td>
          <td>${formatDateTime(invite.expiresAt)}</td>
          <td><a href="${link}" target="_blank" rel="noreferrer">${link}</a></td>
        </tr>`;
    })
    .join("");
}

async function createInvite() {
  if (!roleAllowsOrgEdit()) return;
  const orgId = $("inviteOrgSelect")?.value;
  if (!orgId) return alert("Select an organization.");
  const type = $("inviteTypeSelect")?.value || "CUSTOMER";
  try {
    const data = await apiJson("/api/invites", {
      method: "POST",
      body: JSON.stringify({ orgId, type })
    });
    if (data && data.data) {
      const link = `/signup.html?token=${encodeURIComponent(data.data.token)}`;
      const result = $("inviteResult");
      const url = $("inviteResultUrl");
      if (result && url) {
        result.style.display = "block";
        url.textContent = link;
      }
    }
    await loadInvites();
  } catch (e) {
    alert(e.message || "Unable to create invite.");
  }
}

function bindInviteCreate() {
  const btn = $("inviteCreateBtn");
  if (!btn) return;
  if (btn.dataset.bound === "true") return;
  btn.dataset.bound = "true";
  btn.addEventListener("click", createInvite);
}

async function loadUsers() {
  try {
    const data = await apiJson("/api/employees");
    if (!data) return;
    adminState.users = data.data || [];
    renderUsers();
  } catch (e) {
    adminState.users = [];
    renderUsers();
  }
}

function renderUsers() {
  const body = $("userTable");
  const empty = $("userEmpty");
  if (!body) return;
  if (!adminState.users.length) {
    body.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";
  body.innerHTML = adminState.users
    .map(
      (user) => `
        <tr>
          <td>${user.email}</td>
          <td><span class="roleBadge">${user.role}</span></td>
          <td>${formatDate(user.createdAt)}</td>
          <td>${user.isActive === false ? "Disabled" : "Active"}</td>
          <td><button class="btn ghost actionDisabled" title="Role editing coming soon">Edit</button></td>
        </tr>`
    )
    .join("");
}

function bindEmployeeCreate() {
  const btn = $("employeeCreateBtn");
  if (!btn) return;
  if (btn.dataset.bound === "true") return;
  btn.dataset.bound = "true";
  btn.addEventListener("click", () => {
    if (!roleAllowsEmployeeEdit()) return;
    openModal({
      title: "Add Employee",
      content: `<form id="employeeCreateForm" class="formGrid">
        <label class="fieldGroup">
          <span>Email</span>
          <input name="email" type="email" required />
        </label>
        <label class="fieldGroup">
          <span>Role</span>
          <select name="role">
            <option value="SUPPORT">SUPPORT</option>
            <option value="SALES">SALES</option>
            <option value="ADMIN">ADMIN</option>
            <option value="SUPER_ADMIN">SUPER_ADMIN</option>
          </select>
        </label>
        <button class="btn primary" type="submit">Create Employee</button>
      </form>`
    });
    document.getElementById("employeeCreateForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = Object.fromEntries(new FormData(e.target));
      try {
        const data = await apiJson("/api/employees", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        if (data && data.data) {
          closeModal();
          await loadUsers();
          openModal({
            title: "Employee Created",
            content: `<div class="detailBlock"><div class="detailLabel">Employee email</div><div class="detailValue">${data.data.email}</div></div>
            <div class="detailBlock" id="employeeCredentialBlock"><div class="detailLabel">One-time temporary password</div><div class="detailValue"><strong id="employeeTempPassword">${data.data.tempPassword}</strong></div>
            <div class="muted" style="font-size:12px;">Store this securely before closing the dialog. It cannot be shown again.</div>
            <div class="credentialActions"><button class="btn primary" id="employeeCopyPasswordBtn" type="button">Copy password</button></div></div>`
          });
          $("employeeCopyPasswordBtn")?.addEventListener("click", () => {
            copyText($("employeeTempPassword")?.textContent, "Employee password copied.");
          });
        }
      } catch (err) {
        alert(err.message || "Unable to create employee.");
      }
    });
  });
}

function populateOrgSelects() {
  const orgOptions = adminState.orgs
    .map((org) => `<option value="${org.orgId || org.id}">${org.name || org.orgId}</option>`)
    .join("");
  ["inviteOrgSelect", "billingOrgSelect", "flagOrgSelect"].forEach((id) => {
    const el = $(id);
    if (el) {
      const prev = el.value;
      el.innerHTML = orgOptions || "<option value=\"\">No organizations</option>";
      if (prev && adminState.orgs.find((o) => (o.orgId || o.id) === prev)) {
        el.value = prev;
      }
    }
  });
  updateBillingFields();
  loadFeatureFlags();
}

function updateBillingFields() {
  const select = $("billingOrgSelect");
  if (!select) return;
  const org = getOrgById(select.value);
  if (!org) {
    $("billingSaveNote").textContent = "Select an organization to edit billing.";
    return;
  }
  $("billingSaveNote").textContent = roleAllowsOrgEdit() ? "Changes save immediately." : "Read-only access.";
  $("billingPlanDisplay").value = org.billingPlan === "CORE_STANDARD" ? "Standard (Contact Sales)" : "Pilot: $50/vehicle/month";
  $("billingContactName").value = org.billingContactName || "";
  $("billingEmail").value = org.billingEmail || "";
  $("billingMethod").value = org.paymentMethodType || "CARD";
  $("billingCardNumber").value = org.last4 || "";
  $("billingExpMonth").value = org.billingExpMonth || "";
  $("billingExpYear").value = org.billingExpYear || "";
  $("billingCvc").value = "";
  $("billingRouting").value = org.routingLast4 || "";
  $("billingAccount").value = org.accountLast4 || "";
  toggleBillingFields();
}

function toggleBillingFields() {
  const method = $("billingMethod")?.value || "CARD";
  const card = $("billingCardFields");
  const ach = $("billingAchFields");
  if (card) card.style.display = method === "CARD" ? "grid" : "none";
  if (ach) ach.style.display = method === "ACH" ? "grid" : "none";
}

async function saveBilling() {
  if (!roleAllowsOrgEdit()) return;
  const orgId = $("billingOrgSelect")?.value;
  if (!orgId) return;
  const org = getOrgById(orgId);
  const method = $("billingMethod").value;
  const cardNumber = $("billingCardNumber").value.replace(/\D/g, "");
  const account = $("billingAccount").value.replace(/\D/g, "");
  const routing = $("billingRouting").value.replace(/\D/g, "");
  const last4 = cardNumber ? cardNumber.slice(-4) : org?.last4 || "";
  const accountLast4 = account ? account.slice(-4) : org?.accountLast4 || "";
  const routingLast4 = routing ? routing.slice(-4) : org?.routingLast4 || "";
  const payload = {
    billingContactName: $("billingContactName").value.trim(),
    billingEmail: $("billingEmail").value.trim(),
    paymentMethodType: method,
    last4: method === "CARD" ? last4 : "",
    accountLast4: method === "ACH" ? accountLast4 : "",
    routingLast4: method === "ACH" ? routingLast4 : "",
    billingExpMonth: $("billingExpMonth").value.trim(),
    billingExpYear: $("billingExpYear").value.trim(),
    billingUpdatedAt: new Date().toISOString()
  };
  try {
    await apiJson(`/api/orgs/${encodeURIComponent(orgId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    await loadOrgs();
    updateBillingFields();
  } catch (e) {
    alert(e.message || "Unable to save billing.");
  }
}

async function loadFeatureFlags() {
  const orgId = $("flagOrgSelect")?.value;
  if (!orgId) return;
  try {
    const data = await apiJson(`/api/orgs/${encodeURIComponent(orgId)}/feature-flags`);
    if (!data) return;
    const flags = data.data || {};
    $("flagCamera").checked = !!flags.cameraIntegration;
    $("flagSafety").checked = !!flags.safetyScorePack;
    $("flagCompliance").checked = !!flags.compliancePack;
  } catch (e) {}
}

function bindFeatureFlags() {
  const flagMap = {
    flagCamera: "cameraIntegration",
    flagSafety: "safetyScorePack",
    flagCompliance: "compliancePack"
  };
  Object.entries(flagMap).forEach(([id, key]) => {
    const input = $(id);
    if (!input) return;
    if (input.dataset.bound === "true") return;
    input.dataset.bound = "true";
    input.addEventListener("change", async () => {
      if (!roleAllowsOrgEdit()) {
        input.checked = !input.checked;
        return;
      }
      const orgId = $("flagOrgSelect")?.value;
      if (!orgId) return;
      try {
        await apiJson(`/api/orgs/${encodeURIComponent(orgId)}/feature-flags`, {
          method: "PATCH",
          body: JSON.stringify({ [key]: input.checked })
        });
      } catch (e) {
        input.checked = !input.checked;
      }
    });
  });
}

function bindSettings() {
  const densityToggle = $("densityToggle");
  if (densityToggle) {
    if (densityToggle.dataset.bound !== "true") {
      densityToggle.dataset.bound = "true";
      densityToggle.addEventListener("change", () => {
        const next = densityToggle.checked;
        document.body.classList.toggle("density-compact", next);
        saveDensitySetting(next);
      });
    }
    const compact = loadDensitySetting();
    densityToggle.checked = compact;
    document.body.classList.toggle("density-compact", compact);
  }
  const themeSelect = $("portalThemeSelect");
  if (themeSelect) {
    themeSelect.value = document.documentElement.dataset.theme || "light-blue";
    if (themeSelect.dataset.bound !== "true") {
      themeSelect.dataset.bound = "true";
      themeSelect.addEventListener("change", (e) => {
        if (typeof window.applyTheme === "function") {
          window.applyTheme(e.target.value);
        } else {
          document.documentElement.dataset.theme = e.target.value;
        }
      });
    }
  }
}

function bindOrgRowClick() {
  const body = $("orgTable");
  if (!body) return;
  if (body.dataset.bound === "true") return;
  body.dataset.bound = "true";
  body.addEventListener("click", (e) => {
    const row = e.target.closest("tr");
    if (!row) return;
    const action = e.target.getAttribute("data-action");
    if (action === "delete-org") {
      const orgId = e.target.getAttribute("data-org-id");
      const org = getOrgById(orgId);
      confirmOrgDelete(org);
      return;
    }
    const orgId = row.getAttribute("data-org-id") || e.target.getAttribute("data-org-id");
    if (orgId) selectOrg(orgId);
  });
}

function bindLeadRowClick() {
  const body = $("leadTable");
  if (!body) return;
  if (body.dataset.bound === "true") return;
  body.dataset.bound = "true";
  body.addEventListener("click", (e) => {
    const row = e.target.closest("tr");
    if (!row) return;
    const leadId = row.getAttribute("data-lead-id") || e.target.getAttribute("data-lead-id");
    if (leadId) selectLead(leadId);
  });
}

function bindView(route) {
  if (route === "overview") {
    loadOverview();
    loadAudit();
  } else if (route === "orgs") {
    bindOrgRowClick();
    $("orgSearch")?.addEventListener("input", renderOrgs);
    bindOrgCreate();
    $("orgSaveBtn")?.addEventListener("click", saveOrg);
    $("orgCreateCustomerBtn")?.addEventListener("click", createCustomerLogin);
    $("orgResetCustomerBtn")?.addEventListener("click", resetCustomerPassword);
    $("customerCopyPasswordBtn")?.addEventListener("click", () => {
      copyText($("customerTempPassword")?.textContent, "Customer password copied.");
    });
    $("orgFleetRefreshBtn")?.addEventListener("click", () => {
      if (adminState.selectedOrgId) loadOrgFleet(adminState.selectedOrgId);
    });
    const showDeleted = $("orgShowDeleted");
    if (showDeleted) {
      showDeleted.checked = adminState.showDeletedOrgs;
      if (showDeleted.dataset.bound !== "true") {
        showDeleted.dataset.bound = "true";
        showDeleted.addEventListener("change", () => {
          adminState.showDeletedOrgs = showDeleted.checked;
          loadOrgs();
        });
      }
    }
    loadOrgs();
  } else if (route === "leads") {
    bindLeadRowClick();
    bindLeadFilters();
    $("leadSaveBtn")?.addEventListener("click", saveLead);
    $("leadConvertBtn")?.addEventListener("click", convertLead);
    loadLeads();
  } else if (route === "invites") {
    bindInviteCreate();
    loadOrgs();
    loadInvites();
  } else if (route === "billing") {
    $("billingSaveBtn")?.addEventListener("click", saveBilling);
    $("billingMethod")?.addEventListener("change", toggleBillingFields);
    $("billingOrgSelect")?.addEventListener("change", updateBillingFields);
    loadOrgs();
  } else if (route === "features") {
    $("flagOrgSelect")?.addEventListener("change", loadFeatureFlags);
    bindFeatureFlags();
    loadOrgs();
  } else if (route === "system-health") {
    loadSystemHealth();
  } else if (route === "audit-log") {
    loadAudit();
  } else if (route === "users") {
    bindEmployeeCreate();
    loadUsers();
  } else if (route === "settings") {
    bindSettings();
  } else if (route === "api-keys") {
    bindApiKeys();
    loadApiKeys();
  }
  applyRoleState();
}

// ── Partner API Keys ─────────────────────────────────────────────────────────

function bindApiKeys() {
  const createBtn = $("apiKeyCreateBtn");
  if (createBtn && createBtn.dataset.bound !== "true") {
    createBtn.dataset.bound = "true";
    createBtn.addEventListener("click", createApiKey);
  }
  const copyBtn = $("apiKeyCopyBtn");
  if (copyBtn && copyBtn.dataset.bound !== "true") {
    copyBtn.dataset.bound = "true";
    copyBtn.addEventListener("click", () => {
      const val = $("apiKeyRawValue")?.textContent || "";
      navigator.clipboard.writeText(val).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy to clipboard"; }, 2000);
      }).catch(() => {});
    });
  }
}

async function loadApiKeys() {
  try {
    const data = await apiJson("/api/admin/api-keys");
    const keys = data?.data || [];
    const tbody = $("apiKeyTable");
    const empty = $("apiKeyEmpty");
    const count = $("apiKeyCount");
    if (count) count.textContent = `${keys.length} key${keys.length !== 1 ? "s" : ""}`;
    if (!tbody) return;
    if (!keys.length) {
      tbody.innerHTML = "";
      if (empty) empty.style.display = "";
      return;
    }
    if (empty) empty.style.display = "none";
    tbody.innerHTML = keys.map((k) => `
      <tr>
        <td><strong>${k.partnerName || "--"}</strong></td>
        <td><span style="font-family:ui-monospace,monospace;font-size:11px;background:#EFF6FF;padding:2px 7px;border-radius:4px;color:#1D4ED8">${k.tier || "--"}</span></td>
        <td style="font-size:12px;color:#6B7280">${k.orgId || "--"}</td>
        <td style="font-size:12px;color:#6B7280">${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "Never"}</td>
        <td style="font-size:12px;color:#6B7280">${k.createdAt ? new Date(k.createdAt).toLocaleDateString() : "--"}</td>
        <td><span style="font-size:11px;font-weight:600;color:${k.enabled ? "#166534" : "#991b1b"}">${k.enabled ? "Active" : "Revoked"}</span></td>
        <td>${k.enabled ? `<button class="btn ghost" data-revoke-id="${k.id}" type="button" style="font-size:12px;color:#e53e3e">Revoke</button>` : ""}</td>
      </tr>
    `).join("");
    tbody.querySelectorAll("[data-revoke-id]").forEach((btn) => {
      btn.addEventListener("click", () => revokeApiKey(btn.getAttribute("data-revoke-id")));
    });
  } catch (err) {
    const count = $("apiKeyCount");
    if (count) count.textContent = "Failed to load";
  }
}

async function createApiKey() {
  const partner = ($("apiKeyPartner")?.value || "").trim();
  const tier    = $("apiKeyTier")?.value || "partner_ml";
  const orgId   = ($("apiKeyOrgId")?.value || "").trim() || null;
  if (!partner) { alert("Partner name is required."); return; }
  const btn = $("apiKeyCreateBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Generating..."; }
  try {
    const result = await apiJson("/api/admin/api-keys", {
      method: "POST",
      body: JSON.stringify({ partnerName: partner, tier, orgId })
    });
    if (result?.success && result.data?.apiKey) {
      const raw = result.data.apiKey;
      const resultEl = $("apiKeyResult");
      const valEl = $("apiKeyRawValue");
      if (valEl) valEl.textContent = raw;
      if (resultEl) resultEl.style.display = "";
      if ($("apiKeyPartner")) $("apiKeyPartner").value = "";
      await loadApiKeys();
    } else {
      alert(result?.error || "Failed to create API key.");
    }
  } catch (err) {
    alert(err?.message || "Failed to create API key.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Generate API Key"; }
  }
}

async function revokeApiKey(id) {
  if (!confirm("Revoke this API key? The partner will lose access immediately.")) return;
  try {
    await apiJson(`/api/admin/api-keys/${id}`, { method: "DELETE" });
    await loadApiKeys();
  } catch (err) {
    alert(err?.message || "Failed to revoke key.");
  }
}

function bindNav() {
  const nav = $("employeeNav");
  if (!nav) return;
  nav.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const route = btn.getAttribute("data-route");
      if (!route) return;
      diagLog("nav click", route);
      window.location.hash = route;
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        btn.click();
      }
    });
  });
}

function bindGlobalSearch() {
  const input = $("adminSearch");
  if (!input || input.dataset.bound === "true") return;
  input.dataset.bound = "true";
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const term = input.value.trim();
    if (!term) return;
    window.location.hash = "orgs";
    window.setTimeout(() => {
      const orgSearch = $("orgSearch");
      if (!orgSearch) return;
      orgSearch.value = term;
      renderOrgs();
      orgSearch.focus();
    }, 120);
  });
}

function initRouting() {
  const applyRoute = () => {
    const route = window.location.hash.replace("#", "") || "overview";
    renderView(route);
  };
  window.addEventListener("hashchange", applyRoute);
  applyRoute();
}

function bindModalClose() {
  $("modalClose")?.addEventListener("click", closeModal);
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
}

document.addEventListener("DOMContentLoaded", () => {
  window.__EMP_PORTAL_BOOT = true;
  updateConsoleDebug({
    status: "booted",
    error: "--"
  });
  document.documentElement.style.pointerEvents = "auto";
  document.body.style.pointerEvents = "auto";
  const modal = $("modalOverlay");
  if (modal) {
    modal.hidden = true;
    modal.classList.remove("is-open");
  }
  clearLegacyEmployeeTokens();
  bindGlobalSearch();
  updateConsoleDebug({
    token: "cleared",
    cookie: document.cookie ? "present" : "missing",
    authType: document.cookie ? "cookie" : "none"
  });
  setLoading(true, "Initializing console…");
  bindNav();
  initRouting();
  bindModalClose();
  loadMe().finally(() => setLoading(false, ""));

  $("adminRefresh")?.addEventListener("click", () => renderView(adminState.currentRoute));
  $("resetAuthBtn")?.addEventListener("click", () => {
    clearLegacyEmployeeTokens();
    window.location.href = "/employee-login.html";
  });
  $("employeeSignOut")?.addEventListener("click", async () => {
    try {
      await fetch(resolveApiUrl("/api/employee/logout"), { method: "POST", credentials: "include" });
    } catch (e) {}
    clearLegacyEmployeeTokens();
    window.location.href = "/employee-login.html";
  });
});
