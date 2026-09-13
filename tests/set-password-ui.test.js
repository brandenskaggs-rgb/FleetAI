const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/set-password.js'), 'utf8');

function setup({ token = 'test-setup-token', role = 'customer', blocked = false, search = '', fetcher } = {}) {
  const elements = {};
  for (const id of ['setPasswordNew', 'setPasswordConfirm', 'setPasswordBtn', 'setPasswordMessage', 'setPasswordRetry', 'setPasswordBack', 'setPasswordForm']) {
    elements[id] = { value: '', hidden: true, disabled: false, textContent: '', style: {}, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } };
  }
  const storage = new Map([['fleetai_first_login_token', token], ['fleetai_first_login_role', role]]);
  const timers = new Map();
  const requests = [];
  let ready;
  const location = { origin: 'https://fleet.example.test', search, replace(target) { this.target = target; } };
  const context = vm.createContext({
    window: { location }, URL, URLSearchParams, AbortController,
    document: { getElementById: id => elements[id], addEventListener(name, fn) { if (name === 'DOMContentLoaded') ready = fn; } },
    sessionStorage: { getItem(k) { if (blocked) throw Error('blocked'); return storage.get(k); }, removeItem(k) { storage.delete(k); } },
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher ? fetcher(url, options) : { ok: true, status: 200, json: async () => ({ ok: true, user: { role: 'CUSTOMER_ADMIN' } }) }; }
  });
  vm.runInContext(source, context);
  ready();
  return { elements, storage, timers, requests, location,
    fill(next = 'Synthetic-Test-Password', confirm = next) { elements.setPasswordNew.value = next; elements.setPasswordConfirm.value = confirm; elements.setPasswordNew.handlers.input(); },
    submit() { return elements.setPasswordForm.handlers.submit({ preventDefault() {} }); }
  };
}

test('missing or blocked tab storage explains recovery instead of silently disabling save', async () => {
  for (const options of [{token:''}, {blocked:true}]) {
    const ui = setup(options); ui.fill(); await ui.submit();
    assert.equal(ui.elements.setPasswordBtn.disabled, true);
    assert.match(ui.elements.setPasswordMessage.textContent, /same tab/);
    assert.equal(ui.elements.setPasswordRetry.hidden, false);
    assert.equal(ui.requests.length, 0);
  }
});
test('validation rejects mismatched or short passwords', async () => {
  const ui = setup();
  for (const values of [['short','short'], ['long-enough-password','different']]) {
    ui.fill(...values); await ui.submit(); assert.equal(ui.elements.setPasswordBtn.disabled, true);
  }
  assert.equal(ui.requests.length, 0);
});
test('successful setup uses cookie auth, clears setup secrets, and opens customer dashboard', async () => {
  const ui = setup(); ui.fill(); await ui.submit();
  assert.equal(ui.requests[0].url, '/api/auth/set-password');
  assert.equal(ui.requests[0].options.credentials, 'include');
  assert.equal(JSON.parse(ui.requests[0].options.body).token, 'test-setup-token');
  assert.equal(ui.location.target, '/ui/fleetai-dashboard.html');
  assert.equal(ui.storage.has('fleetai_first_login_token'), false);
  assert.equal(ui.elements.setPasswordNew.value, '');
  assert.equal(ui.elements.setPasswordBtn.disabled, true);
  assert.equal(ui.timers.size, 0);
});
test('redirect cannot leave the dashboard path or origin', async () => {
  for (const returnTo of ['https://attacker.example/', '//attacker.example/', 'javascript:alert(1)', '/employee-console.html', '/customer-login.html']) {
    const ui = setup({ search: '?returnTo=' + encodeURIComponent(returnTo) });
    ui.fill(); await ui.submit(); assert.equal(ui.location.target, '/ui/fleetai-dashboard.html');
  }
  const ui = setup({ search: '?returnTo=' + encodeURIComponent('/ui/fleetai-dashboard.html#pairing') });
  ui.fill(); await ui.submit(); assert.equal(ui.location.target, '/ui/fleetai-dashboard.html#pairing');
});
test('employee setup uses the employee workspace and recovery link', async () => {
  const ui = setup({ role: 'employee', fetcher: async () => ({ok:true, status:200,json:async()=>({ok:true,user:{role:'SUPER_ADMIN'}})}) });
  assert.equal(ui.elements.setPasswordBack.href, '/employee-login.html');
  ui.fill(); await ui.submit(); assert.equal(ui.location.target, '/employee-console.html');
});
test('expired tokens, throttling, non-JSON and server errors never leak response details', async () => {
  for (const status of [400,401,403,409,429,500]) {
    const ui = setup({fetcher:async()=>({ok:false,status,json:async()=>({error:'private-server-detail'})})});
    ui.fill(); await ui.submit();
    assert(!ui.elements.setPasswordMessage.textContent.includes('private-server-detail'));
    assert.equal(ui.elements.setPasswordBtn.textContent, 'Save password');
    assert.equal(ui.timers.size, 0);
    if (status < 429) assert.equal(ui.elements.setPasswordBtn.disabled, true);
  }
  const ui = setup({fetcher:async()=>({ok:true,status:200,json:async()=>{throw Error('private-html')}})});
  ui.fill(); await ui.submit(); assert.match(ui.elements.setPasswordMessage.textContent,/could not confirm/);
});
test('stalled requests time out and duplicate submissions cannot issue another change', async () => {
  const ui = setup({fetcher:async(_, {signal}) => new Promise((resolve,reject) => signal.addEventListener('abort',()=>reject(Error('aborted'))))});
  ui.fill(); const pending = ui.submit(); ui.fill(); await ui.submit();
  assert.equal(ui.requests.length,1); assert.equal(ui.elements.setPasswordBtn.disabled,true);
  [...ui.timers.values()][0](); await pending;
  assert.match(ui.elements.setPasswordMessage.textContent,/may have completed/);
  assert.equal(ui.elements.setPasswordBtn.disabled,false);
  assert.equal(ui.elements.setPasswordRetry.hidden,false);
});
test('page has an accessible submit form and no unused temporary-password or secret debug fields', () => {
  const html = fs.readFileSync(path.join(__dirname,'../ui/settings/set-password.html'),'utf8');
  assert.match(html, /<form[^>]+id="setPasswordForm"/);
  assert.match(html, /id="setPasswordBtn" type="submit"/);
  assert.match(html, /aria-live="polite"/);
  assert(!html.includes('setPasswordCurrent'));
  assert(!html.includes('setPwdDbgToken'));
});
