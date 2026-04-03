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

## Quarantined legacy surface

The old `app/` dashboard surface was quarantined because it duplicated dashboard/settings/billing pages and created source-of-truth confusion.

See `.quarantine/` for preserved legacy copies if needed.

## Rule

Do not add new product logic to quarantined legacy surfaces. New work should target:
- root marketing/login pages
- `ui/` for the customer app
- `server/routes/*` and shared backend code
