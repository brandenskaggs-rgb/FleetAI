# Fleet AI UI/Portal Overhaul Notes

Summary
- Added enterprise-styled legal pages with TOC, anchors, and compliance language.
- Fixed broken legal links and added explicit server routes + redirects for legacy paths.
- Added /api/ai-advisor, /api/billing, /api/feature-flags aliases to prevent API 404s.
- Expanded Super Admin overview KPIs (MRR, Active Orgs, Active Pilots, Active Vehicles).
- Refined modal system and feature-flag toggles for portal stability.
- Kept smooth scroll/reveal and consistent spacing system across pages.

Files changed
- server.js
- css/site-layout.css
- css/site-components.css
- employee-portal.html
- js/admin-portal.js
- ui/fleetai-dashboard.html
- legal/privacy.html (new)
- legal/terms.html (new)
- index.html, product.html, pricing.html, pilot.html, about.html, security.html, request-demo.html, login.html, privacy.html, terms.html, signup.html, employee-login.html, admin/setup.html, app/dashboard.html, ui/fleetai-dashboard.html

Manual test checklist
1) npm start
2) Confirm legal pages load:
   - http://localhost:3000/legal/privacy.html
   - http://localhost:3000/legal/terms.html
3) Confirm footer legal links point to /legal/* and show "© 2026 Fleet AI".
4) Confirm employee login works and portal loads:
   - http://localhost:3000/employee-login.html
   - http://localhost:3000/employee-portal.html
5) In portal, click each sidebar tab and verify distinct content.
6) Verify Feature Flags toggles render and save.
7) Verify API endpoints do not 404:
   - /api/admin/setup/status
   - /api/billing/:orgId
   - /api/feature-flags/:orgId
   - /api/ai-advisor/status
8) Dashboard text should not clip:
   - http://localhost:3000/ui/fleetai-dashboard.html
