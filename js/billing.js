const USER_KEY = "fleetai.user";
const apiUrl = window.apiUrl || ((path) => path);
const BILLING_ENDPOINT = apiUrl("/api/billing/settings");
const PAYMENT_ENDPOINT = apiUrl("/api/billing/payment-method");
let currentBilling = null;
let currentPayment = null;

function getUser(){
  try{ return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }catch(e){ return null; }
}
function setUser(user){
  try{ localStorage.setItem(USER_KEY, JSON.stringify(user)); }catch(e){}
}

async function apiJson(url, options = {}){
  const init = Object.assign({ headers: { "Content-Type": "application/json" } }, options);
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if(!res.ok){
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function showToast(text, tone = "success"){
  const el = document.getElementById("billingToast");
  if(!el) return;
  el.textContent = text;
  el.classList.remove("success", "error");
  el.classList.add(tone);
  el.style.display = "flex";
  window.clearTimeout(showToast._timer);
  showToast._timer = window.setTimeout(() => {
    el.style.display = "none";
  }, 3200);
}

function setInlineMessage(el, text){
  if(!el) return;
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}

function formatDate(value){
  if(!value) return "N/A";
  const dt = new Date(value);
  if(Number.isNaN(dt.getTime())) return "N/A";
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function updateUserPlan(status){
  const user = getUser();
  if(!user) return;
  if(status === "ACTIVE"){
    user.planStatus = "paid";
  } else if(status === "PILOT"){
    user.planStatus = "pilot";
  } else {
    user.planStatus = "none";
  }
  setUser(user);
}

function renderPlan(billing){
  currentBilling = billing || {};
  const status = currentBilling.status || "NONE";
  const statusBadge = document.getElementById("billingStatus");
  const pill = document.getElementById("planStatusPill");
  const nextEl = document.getElementById("nextBillingDate");
  const priceEl = document.getElementById("planPrice");
  if(statusBadge){
    statusBadge.textContent = status === "ACTIVE" ? "Active" : status === "PILOT" ? "Pilot" : "No plan selected";
  }
  if(pill){
    pill.textContent = status === "ACTIVE" ? "Active" : status === "PILOT" ? "Pilot" : "Not selected";
  }
  if(nextEl){
    nextEl.textContent = status === "ACTIVE" ? formatDate(currentBilling.nextBillAt) : "N/A";
  }
  if(priceEl){
    priceEl.textContent = `$${currentBilling.priceMonthly ?? 59} / month`;
  }
  const btn = document.getElementById("btnPlanAction");
  if(btn){
    if(status === "NONE"){
      btn.textContent = "Select Pilot Plan";
      btn.disabled = false;
    } else if(status === "PILOT"){
      btn.textContent = "Pilot Selected";
      btn.disabled = true;
    } else {
      btn.textContent = "Plan Active";
      btn.disabled = true;
    }
  }
}

function fillBillingDetails(billing){
  const vehicle = document.getElementById("billingVehicleCount");
  const term = document.getElementById("billingContractTerm");
  const notes = document.getElementById("billingNotes");
  if(vehicle) vehicle.value = billing?.vehicleCount ?? "";
  if(term) term.value = billing?.contractTermMonths ? String(billing.contractTermMonths) : "";
  if(notes) notes.value = billing?.notes ?? "";
}

function digitsOnly(value){
  return (value || "").replace(/\D/g, "");
}

function inferCardBrand(number){
  if(!number) return "Card";
  if(number.startsWith("4")) return "Visa";
  if(number.startsWith("5")) return "Mastercard";
  if(number.startsWith("3")) return "Amex";
  if(number.startsWith("6")) return "Discover";
  return "Card";
}

function monthOptions(){
  const opts = [];
  for(let i = 1; i <= 12; i += 1){
    const value = String(i).padStart(2, "0");
    opts.push(`<option value="${value}">${value}</option>`);
  }
  return opts.join("");
}

function yearOptions(){
  const opts = [];
  const start = new Date().getFullYear();
  for(let i = 0; i <= 12; i += 1){
    const value = String(start + i);
    opts.push(`<option value="${value}">${value}</option>`);
  }
  return opts.join("");
}

function renderPaymentFields(){
  const container = document.getElementById("paymentFields");
  const hint = document.getElementById("paymentHint");
  if(!container) return;
  const type = document.getElementById("paymentType")?.value || "CARD_STUB";
  const payment = currentPayment || {};
  if(type === "ACH_STUB"){
    container.innerHTML = `
      <div class="formRow">
        <label class="fieldGroup">
          <span class="fieldLabel">Account holder / business name</span>
          <input id="achAccountName" type="text" placeholder="Fleet AI Logistics, Inc." />
        </label>
        <label class="fieldGroup">
          <span class="fieldLabel">Account type</span>
          <select id="achAccountType">
            <option value="">Select</option>
            <option value="CHECKING">Checking</option>
            <option value="SAVINGS">Savings</option>
          </select>
        </label>
      </div>
      <div class="formRow">
        <label class="fieldGroup">
          <span class="fieldLabel">Routing number</span>
          <input id="achRouting" type="text" inputmode="numeric" placeholder="9 digits" />
        </label>
        <label class="fieldGroup">
          <span class="fieldLabel">Account number</span>
          <input id="achAccount" type="password" inputmode="numeric" placeholder="4-17 digits" />
        </label>
      </div>
    `;
    if(hint) hint.textContent = "Stub setup only. Bank draft is not enabled yet.";
    setTimeout(() => {
      const name = document.getElementById("achAccountName");
      const accountType = document.getElementById("achAccountType");
      if(name) name.value = payment.billingName || "";
      if(accountType) accountType.value = payment.accountType || "";
    }, 0);
  } else {
    container.innerHTML = `
      <div class="formRow">
        <label class="fieldGroup">
          <span class="fieldLabel">Cardholder name</span>
          <input id="cardholderName" type="text" placeholder="Name on card" />
        </label>
        <label class="fieldGroup">
          <span class="fieldLabel">Card number</span>
          <input id="cardNumber" type="text" inputmode="numeric" placeholder="1234 5678 9012 1234" />
        </label>
      </div>
      <div class="formRow">
        <label class="fieldGroup">
          <span class="fieldLabel">Exp month</span>
          <select id="cardExpMonth">
            <option value="">MM</option>
            ${monthOptions()}
          </select>
        </label>
        <label class="fieldGroup">
          <span class="fieldLabel">Exp year</span>
          <select id="cardExpYear">
            <option value="">YYYY</option>
            ${yearOptions()}
          </select>
        </label>
      </div>
      <div class="formRow">
        <label class="fieldGroup">
          <span class="fieldLabel">CVC</span>
          <input id="cardCvc" type="password" inputmode="numeric" placeholder="CVC" />
        </label>
        <label class="fieldGroup">
          <span class="fieldLabel">Billing ZIP / Postal</span>
          <input id="cardZip" type="text" placeholder="ZIP or postal code" />
        </label>
      </div>
    `;
    if(hint) hint.textContent = "This is a stub setup. No real charge will be processed yet.";
    setTimeout(() => {
      const name = document.getElementById("cardholderName");
      const expMonth = document.getElementById("cardExpMonth");
      const expYear = document.getElementById("cardExpYear");
      const zip = document.getElementById("cardZip");
      if(name) name.value = payment.billingName || "";
      if(expMonth) expMonth.value = payment.expMonth ? String(payment.expMonth).padStart(2, "0") : "";
      if(expYear) expYear.value = payment.expYear ? String(payment.expYear) : "";
      if(zip) zip.value = payment.postalCode || "";
    }, 0);
  }
  renderPaymentSummary();
}

function renderPaymentSummary(){
  const summary = document.getElementById("paymentSummary");
  if(!summary) return;
  const payment = currentPayment || {};
  if(!payment.type){
    summary.style.display = "none";
    return;
  }
  if(payment.type === "CARD_STUB" && payment.last4){
    summary.textContent = `${payment.brand || "Card"} - Last 4: ${payment.last4}`;
    summary.style.display = "block";
    return;
  }
  if(payment.type === "ACH_STUB" && payment.accountLast4){
    summary.textContent = `Account last 4: ${payment.accountLast4}`;
    summary.style.display = "block";
    return;
  }
  summary.style.display = "none";
}

async function loadBilling(){
  const data = await apiJson(BILLING_ENDPOINT);
  renderPlan(data.data);
  fillBillingDetails(data.data);
  updateUserPlan(data.data.status);
  return data.data;
}

async function loadPayment(){
  const data = await apiJson(PAYMENT_ENDPOINT);
  currentPayment = data.data || {};
  const type = document.getElementById("paymentType");
  if(type && currentPayment.type){
    type.value = currentPayment.type;
  }
  const email = document.getElementById("paymentBillingEmail");
  if(email) email.value = currentPayment.billingEmail || "";
  renderPaymentFields();
  return currentPayment;
}

function validateEmail(value){
  return /^[^@]+@[^@]+\.[^@]+$/.test(value || "");
}

function bindActions(){
  const planMsg = document.getElementById("planMsg");
  const paymentMsg = document.getElementById("paymentMsg");
  const billingMsg = document.getElementById("billingSettingsMsg");

  const planButton = document.getElementById("btnPlanAction");
  if(planButton){
    planButton.addEventListener("click", async () => {
      setInlineMessage(planMsg, "");
      if((currentBilling?.status || "NONE") !== "NONE") return;
      try{
        const payload = {
          plan: "PILOT_CORE",
          priceMonthly: 59,
          status: "PILOT"
        };
        const data = await apiJson(BILLING_ENDPOINT, {
          method: "POST",
          body: JSON.stringify(payload)
        });
        renderPlan(data.data);
        updateUserPlan(data.data.status);
        showToast("Pilot plan selected.");
      }catch(err){
        setInlineMessage(planMsg, err.message || "Unable to update plan.");
      }
    });
  }

  const typeSelect = document.getElementById("paymentType");
  if(typeSelect){
    typeSelect.addEventListener("change", () => {
      renderPaymentFields();
    });
  }

  const savePayment = document.getElementById("btnSavePayment");
  if(savePayment){
    savePayment.addEventListener("click", async () => {
      setInlineMessage(paymentMsg, "");
      const type = document.getElementById("paymentType")?.value || "CARD_STUB";
      const billingEmail = document.getElementById("paymentBillingEmail")?.value.trim();
      if(!validateEmail(billingEmail)){
        setInlineMessage(paymentMsg, "Billing email is required.");
        return;
      }
      if(type === "ACH_STUB"){
        const name = document.getElementById("achAccountName")?.value.trim();
        const accountType = document.getElementById("achAccountType")?.value;
        const routing = digitsOnly(document.getElementById("achRouting")?.value);
        const account = digitsOnly(document.getElementById("achAccount")?.value);
        if(!name){
          setInlineMessage(paymentMsg, "Account holder name is required.");
          return;
        }
        if(!accountType){
          setInlineMessage(paymentMsg, "Account type is required.");
          return;
        }
        if(routing.length !== 9){
          setInlineMessage(paymentMsg, "Routing number must be 9 digits.");
          return;
        }
        if(account.length < 4 || account.length > 17){
          setInlineMessage(paymentMsg, "Account number must be 4-17 digits.");
          return;
        }
        const payload = {
          type,
          billingEmail,
          billingName: name,
          accountType,
          routingLast4: routing.slice(-4),
          accountLast4: account.slice(-4)
        };
        try{
          const data = await apiJson(PAYMENT_ENDPOINT, {
            method: "POST",
            body: JSON.stringify(payload)
          });
          currentPayment = data.data || payload;
          renderPaymentSummary();
          showToast("Payment method saved.");
        }catch(err){
          setInlineMessage(paymentMsg, err.message || "Unable to save payment method.");
        }
        return;
      }

      const name = document.getElementById("cardholderName")?.value.trim();
      const cardNumber = digitsOnly(document.getElementById("cardNumber")?.value);
      const expMonth = document.getElementById("cardExpMonth")?.value;
      const expYear = document.getElementById("cardExpYear")?.value;
      const cvc = digitsOnly(document.getElementById("cardCvc")?.value);
      const postal = document.getElementById("cardZip")?.value.trim();
      if(!name){
        setInlineMessage(paymentMsg, "Cardholder name is required.");
        return;
      }
      if(cardNumber.length < 12 || cardNumber.length > 19){
        setInlineMessage(paymentMsg, "Card number must be 12-19 digits.");
        return;
      }
      if(!expMonth || !expYear){
        setInlineMessage(paymentMsg, "Expiration month and year are required.");
        return;
      }
      if(cvc.length < 3 || cvc.length > 4){
        setInlineMessage(paymentMsg, "CVC is required.");
        return;
      }
      const payload = {
        type,
        billingEmail,
        billingName: name,
        last4: cardNumber.slice(-4),
        brand: inferCardBrand(cardNumber),
        expMonth: Number(expMonth),
        expYear: Number(expYear),
        postalCode: postal || ""
      };
      try{
        const data = await apiJson(PAYMENT_ENDPOINT, {
          method: "POST",
          body: JSON.stringify(payload)
        });
        currentPayment = data.data || payload;
        renderPaymentSummary();
        showToast("Payment method saved.");
      }catch(err){
        setInlineMessage(paymentMsg, err.message || "Unable to save payment method.");
      }
    });
  }

  const saveBilling = document.getElementById("btnSaveBilling");
  if(saveBilling){
    saveBilling.addEventListener("click", async () => {
      setInlineMessage(billingMsg, "");
      const payload = {
        vehicleCount: Number(document.getElementById("billingVehicleCount")?.value || 0),
        contractTermMonths: Number(document.getElementById("billingContractTerm")?.value || 0),
        notes: document.getElementById("billingNotes")?.value.trim() || ""
      };
      try{
        const data = await apiJson(BILLING_ENDPOINT, {
          method: "POST",
          body: JSON.stringify(payload)
        });
        renderPlan(data.data);
        fillBillingDetails(data.data);
        showToast("Billing settings saved.");
      }catch(err){
        setInlineMessage(billingMsg, err.message || "Unable to save billing settings.");
      }
    });
  }
}

async function initBilling(){
  try{
    await Promise.all([loadBilling(), loadPayment()]);
  }catch(err){
    showToast(err.message || "Unable to load billing data.", "error");
  }
  renderPaymentFields();
  bindActions();
}

document.addEventListener("DOMContentLoaded", initBilling);


