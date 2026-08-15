# McLane J1939 Pilot Intake

Collect this information before selecting production hardware or scheduling an installation.

## Tablet and connection

- Tablet manufacturer and exact model
- Android version and mobile-device-management platform
- Whether USB host mode, Bluetooth, background services, and managed app deployment are allowed
- Photo of the tablet cable and every device between the tablet and truck
- Gateway/interface manufacturer, model, firmware, and ownership or lease status
- Whether the tablet can charge while the CAN interface is attached

## Truck population

- Connector type: black 9-pin, green Type-II 9-pin, RP1226, or another harness
- Representative truck makes, models, years, engines, and transmissions
- Whether the current diagnostic port is occupied and whether an approved splitter is allowed
- Any OEM, maintenance, cybersecurity, or warranty restrictions on passive CAN hardware

## Product boundary

- Confirm whether the pilot replaces predictive-maintenance telemetry only or also the legal ELD/HOS product
- Identify who approves in-cab hardware, network access, cybersecurity, and ELD/compliance changes
- Confirm permission to capture and retain passive CAN traffic for engineering validation

## Pilot resources

- One representative truck per connector/bus family
- One production tablet and its managed configuration
- One approved harness/interface and a safe installation location
- Access to a trusted diagnostic tool for side-by-side RPM, speed, temperature, pressure, fuel, engine-hours, and DTC comparison
- A maintenance window for stationary testing and a controlled road test

## Acceptance criteria

- Android detects and reconnects the interface after cable removal and process restart
- Fleet AI identifies the correct 250 or 500 kbit/s bus without transmitting CAN traffic
- Valid frame flow remains continuous for a 60-minute road test with no unexplained gaps over seven seconds
- Core measurements agree with the reference diagnostic tool within the resolution of their standard SPNs
- Device, driver, vehicle, and organization ownership remain correct after offline upload retries
- Dashboard timestamps track vehicle capture time rather than cellular receive time
- Raw capture replay produces the same normalized measurements as the live run
- Proprietary PGNs remain raw until an authorized definition is supplied and validated
