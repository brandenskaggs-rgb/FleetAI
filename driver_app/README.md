# Fleet AI Driver

Fleet AI Driver is a tablet-first Android app for drivers. It provides a simple dashboard for duty status, daily logs, sensors, and notifications with offline-first storage.

For Class 8 truck acquisition requirements, the supported adapter protocol, and the commissioning checklist, see [`../docs/J1939-HARDWARE-INTEGRATION.md`](../docs/J1939-HARDWARE-INTEGRATION.md).

## Open in Android Studio
- Open Android Studio and select the `driver_app/` folder.
- Let Gradle sync complete.

## Run Instructions
1) Start an API 34+ emulator (Pixel/Tablet) and run the app.
2) In the customer dashboard, select a vehicle and driver and generate a pairing packet.
3) Enter the six-digit pairing code and six-digit driver PIN on the tablet.
4) The successful claim signs in the tablet and assigns its company, driver, and vehicle in one step.
5) Use the bottom tabs: Home, Logbook, Inspections, Sensors, and Notifications.
6) Optional: open Settings for theme and demo mode toggles.

## Backend Connection
- Base URL is configured in `driver_app/app/build.gradle` via `BuildConfig.BASE_URL`.
- The default production value is `https://fleetaiops.com`.
- Override for a real device or hotspot network:
  - Add `FLEETAI_BASE_URL=https://<your-server>/` to `driver_app/gradle.properties` (or pass `-PFLEETAI_BASE_URL=...` in Gradle).
  - Plain HTTP is allowed only for loopback development addresses.

## Demo Mode
- Toggle Demo Mode in Settings to generate local sensor readings without a dongle.

## App Flow
1) Activation: pairing code + driver PIN claims the tablet and returns a scoped device token.
2) Assignment: company, driver, vehicle, and assignment are saved atomically on the tablet.
3) Home: duty status, compliance guidance, and quick actions.
4) Logbook: add HOS-like events (stored locally and synced).
5) Inspections: complete pre-trip and post-trip workflows.
6) Sensors: Bluetooth or USB J1939/OBD connection + PID tiles (or demo).
7) Notifications: in-app list with FCM scaffolding.
8) Diagnostics/Route/Settings: accessible from Home quick actions.

If a tablet loses its local session after a successful claim, the same tablet can enter the same unexpired code and PIN again to receive a replacement token. A different tablet is rejected until dispatch uses **Replace tablet** or revokes the prior assignment.

## Notes
- UI uses a Fleet AI dark/light theme with large buttons and high contrast.
- Offline-first: logs and notifications are stored in Room and synced by WorkManager.
- Bluetooth and notification permissions are requested at runtime.
