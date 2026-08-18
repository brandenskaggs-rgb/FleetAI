# Fleet AI as a Motive-Replacement ELD

## Current position

Fleet AI has a working telemetry and predictive-maintenance path. The ELD compliance core now has a dedicated append-only PostgreSQL ledger, continuous per-device sequence IDs, federal event/line/file checks, automatic motion processing, engine/GPS evidence fields, driver certification records, malfunction/diagnostic records, and output-file generation.

That does not make the current build a registered ELD. Production replacement is blocked until the remaining device workflows and external FMCSA process are complete.

## Remaining product work

- On-device offline ELD engine so legal events and roadside records remain available without the Fleet AI server.
- Independently validate the implemented federal property 60/7 and 70/8 and California intrastate property 80/8 base clocks, then complete passenger rules, split sleeper, recap, adverse conditions, and every carrier-enabled exception profile.
- Full driver edit UI, carrier edit proposals, accept/reject, recertification, and unidentified-driving assignment.
- Co-driver/team operation and secure driver account switching.
- Roadside graph-grid and complete current-day plus previous-seven-day inspection view.
- GNIS-based human-readable location descriptions.
- On-device power, timing, positioning, storage, transfer, and unidentified-driving self-monitoring.
- FMCSA web-service and email transfer using provider-portal credentials.
- Complete user manuals, support process, version control, and compliance evidence archive.

## Regulatory ownership

- FMCSA controls the ELD rule, provider registration, self-certification, registered-device listing, File Validator, data-transfer environment, and eRODS review.
- NHTSA does not issue an ELD certificate. If Fleet AI manufactures or imports vehicle equipment, automotive counsel must classify the hardware and determine applicable NHTSA manufacturer, defect, recall, and reporting duties.
- FCC authorization applies to radio hardware placed on the U.S. market. Use already-authorized tablet and gateway modules where possible; a custom Bluetooth/cellular gateway requires a separate hardware compliance review.

## Release rule

Fleet AI must remain in shadow mode beside a registered ELD until the exact production model/version is publicly listed by FMCSA. No customer-facing copy, contract, or tablet screen may call an unlisted build a compliant or certified ELD.

`ELD_PRODUCTION_ENABLED=true` is fail-closed in configuration validation. It requires the offline engine, HOS validation, roadside display, both transfer methods, independent review, controlled field validation, FMCSA listing confirmation, and provider credentials. These flags are release attestations backed by evidence; they must never be set merely to bypass deployment checks.
