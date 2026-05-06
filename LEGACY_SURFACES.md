# Legacy Surfaces

## Active source of truth

### Public site
- `index.html`
- `product.html`
- `pricing.html`
- `pilot.html`
- `security.html`
- `about.html`
- `request-demo.html`
- `customer-login.html`
- `employee-login.html`

### Customer app
- `ui/`
  - main dashboard: `ui/fleetai-dashboard.html`
  - settings: `ui/settings/set-password.html`
  - driver tablet: `ui/driver-tablet.html`

## Removed legacy surface

The old `app/` dashboard surface has been removed from `clean-auth-rebuild`.
It previously duplicated dashboard, settings, and billing pages and created source-of-truth confusion.

## Rule

Do not add new product logic to removed or quarantined legacy surfaces. New work should target:
- root marketing/login pages
- `ui/` for the customer app and driver experience
- `server/routes/*` and shared backend code
