# DO NOT BREAK

Past failures that must never return:
- Pairing dropdowns empty until create modal is opened
- Fleet/Drivers lists blank on first load after restart
- NAV clicks blocked by overlays or pointer-events
- Auth regressions causing 401 or “User not found” for existing users
- Pairing generate 500 due to storage save issues
- Telemetry marked “waiting for OBD” while stream is active

Explicit guardrails:
- Never block UI input with overlays.
- Never allow “disconnected” state to freeze navigation.
- Pairing generation must surface visible error + logged cause on failure.
