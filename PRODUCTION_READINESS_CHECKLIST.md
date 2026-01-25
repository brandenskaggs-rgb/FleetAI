# Production Readiness Checklist

1) Start server
- `npm start`

2) Health + diagnostics
- Visit `http://localhost:3000/api/health`
- Visit `http://localhost:3000/api/diagnostics`

3) Website lead intake
- Open `http://localhost:3000/request-demo.html`
- Submit Request Demo form -> expect success banner and lead created
- Open `http://localhost:3000/pilot.html`
- Submit Pilot form -> expect success banner and lead created

4) Employee Console
- Sign in at `http://localhost:3000/employee-login.html`
- Verify sidebar tabs switch content and URL hash updates
- Go to Leads & Demos -> confirm new leads appear
- Update lead status + add internal notes -> refresh to confirm persistence

5) Organizations + customer access
- In Organizations tab, create org with name + contact
- Open org detail -> click Create Customer Login, copy temp password
- Confirm Customer login URL: `http://localhost:3000/customer-login.html`

6) Customer forced reset flow
- Open incognito -> sign in with temp password
- Confirm redirect to `http://localhost:3000/ui/force-reset.html`
- Set new password -> redirect to `http://localhost:3000/ui/fleetai-dashboard.html`

7) Org branding in dashboard
- Confirm dashboard header shows `Fleet AI | <Org Name>`
- Confirm header shows `Signed in as <Name>`

8) AI Advisor
- Open AI Advisor tab in dashboard
- Send a message -> expect non-empty response and next steps

9) Billing (stub)
- Visit `http://localhost:3000/app/billing.html`
- Save billing settings -> no errors
- Save payment method -> no errors

10) Pairing
- In dashboard pairing view, generate pairing code
- Verify `/api/pairing/status` returns `{ ok:true }`

11) Public pages + legal links
- Verify `/legal/privacy.html` and `/legal/terms.html` load
- Ensure no “API route not found” banners on any UI action
