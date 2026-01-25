function $(id){
  return document.getElementById(id);
}

const apiUrl = window.apiUrl || ((path) => path);

function statusMessage(msg, ok){
  const el = $("signupStatus");
  if(!el) return;
  el.style.display = "block";
  el.textContent = msg;
  el.style.borderColor = ok ? "var(--primary)" : "var(--bad)";
}

function getToken(){
  const params = new URLSearchParams(window.location.search);
  return params.get("token") || "";
}

async function loadInvite(){
  const token = getToken();
  if(!token){
    statusMessage("Invite token missing.", false);
    return;
  }
  try{
    const res = await fetch(apiUrl(`/api/invites/${encodeURIComponent(token)}`));
    const data = await res.json();
    if(!res.ok){
      statusMessage(data.error || "Invite not found.", false);
      return;
    }
    const invite = data.data;
    $("inviteDetails").textContent = `Org: ${invite.orgId} | Type: ${invite.type} | Expires: ${invite.expiresAt}`;
  }catch(err){
    statusMessage("Unable to validate invite.", false);
  }
}

async function acceptInvite(){
  const token = getToken();
  const email = ($("inviteEmail") || {}).value?.trim() || "";
  const password = ($("invitePassword") || {}).value || "";
  if(!email || !password){
    statusMessage("Email and password required.", false);
    return;
  }
  try{
    const res = await fetch(apiUrl(`/api/invites/${encodeURIComponent(token)}/accept`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if(!res.ok){
      statusMessage(data.error || "Signup failed.", false);
      return;
    }
    statusMessage("Account activated. You can now sign in.", true);
    setTimeout(()=> window.location.href = "/customer-login.html", 1200);
  }catch(err){
    statusMessage("Signup failed. Try again.", false);
  }
}

document.addEventListener("DOMContentLoaded", ()=>{
  $("inviteSubmit")?.addEventListener("click", acceptInvite);
  loadInvite();
});
