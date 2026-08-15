# Fleet AI Driver

Fleet AI Driver is a tablet-first Android app for drivers. It provides a simple dashboard for duty status, daily logs, sensors, and notifications with offline-first storage.

For Class 8 truck acquisition requirements, the supported adapter protocol, and the commissioning checklist, see [`../docs/J1939-HARDWARE-INTEGRATION.md`](../docs/J1939-HARDWARE-INTEGRATION.md).

## Open in Android Studio
- Open Android Studio and select the `driver_app/` folder.
- Let Gradle sync complete.

## Run Instructions
1) Start an API 34+ emulator (Pixel/Tablet) and run the app.
2) Sign in with Company Code + Driver PIN (mocked if backend is offline).
3) Select a vehicle.
4) Use the bottom tabs: Home, Logbook, Sensors, Notifications.
5) Optional: open Settings for theme and demo mode toggles.

## Backend Connection
- Base URL is configured in `driver_app/app/build.gradle` via `BuildConfig.BASE_URL`.
- Default value uses emulator loopback: `http://10.0.2.2:3000/`.
- Override for a real device or hotspot network:
  - Add `FLEETAI_BASE_URL=http://<your-server-ip>:3000/` to `driver_app/gradle.properties` (or pass `-PFLEETAI_BASE_URL=...` in Gradle).

## Demo Mode
- Toggle Demo Mode in Settings to generate local sensor readings without a dongle.

## App Flow
1) Login: Company Code + Driver PIN.
2) Vehicle selection: binds the session to a vehicle.
3) Home: duty status, compliance guidance, quick actions.
4) Logbook: add HOS-like events (stored locally and synced).
5) Sensors: Bluetooth OBD connection + PID tiles (or demo).
6) Notifications: in-app list with FCM scaffolding.
7) Diagnostics/Route/Settings: accessible from Home quick actions.

## Notes
- UI uses a Fleet AI dark/light theme with large buttons and high contrast.
- Offline-first: logs and notifications are stored in Room and synced by WorkManager.
- Bluetooth and notification permissions are requested at runtime.
