# Changelog Guardrails

## Files Added
- spec/FLEETAI_SYSTEM_SPEC.md — baseline snapshot
- spec/WATCHDOG_SPEC.md — watchdog rules
- spec/ROLLBACK_SPEC.md — tagging/rollback workflow
- spec/AUTH_SPEC.md — auth guardrails
- spec/PAIRING_SPEC.md — pairing guardrails
- spec/TELEMETRY_SPEC.md — telemetry guardrails
- spec/UI_NAV_SPEC.md — nav guardrails
- spec/DO_NOT_BREAK.md — regression list
- spec/README_SPEC_USAGE.md — spec usage
- spec/config/api_routes_contract.json — required routes
- spec/config/static_paths_contract.json — required static roots
- spec/config/ui_files_contract.json — required UI files
- spec/config/ui_function_contract.json — required UI functions
- spec/config/pairing_contract.json — pairing contract
- spec/config/watchdog_contract.json — watchdog contract
- tools/watchdog.js — watchdog runner
- tools/preflight-check.js — contract verifier
- tools/link-audit.js — link audit
- tools/print-tag-instructions.js — tag instructions
- tools/tag-known-good.ps1 — tag helper (PowerShell)
- tools/tag-known-good.sh — tag helper (bash)
- js/watchdog-status.js — optional status pill
- admin/debug.html — read-only debug page
- RELEASE_NOTES.md — release notes template

## Files Modified
- server.js — start watchdog and add system status endpoints
- ui/fleetai-dashboard.html — include watchdog-status script
- package.json — add verify + tagging scripts

## Driver App
- driver_app untouched (no changes in this guardrails pass)
