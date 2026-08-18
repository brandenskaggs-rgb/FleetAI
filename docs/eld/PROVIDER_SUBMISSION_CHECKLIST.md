# Fleet AI ELD Provider Submission Checklist

Fleet AI may replace another carrier's ELD only after every item below is complete. A passing software build is necessary but is not FMCSA self-certification.

## Provider account and product identity

- Create the FMCSA ELD Provider account: https://eld.fmcsa.dot.gov/Account/Create/Provider
- Obtain the current Interface Control Document, Web Services Development Handbook, public key, test endpoint, and transfer email from the provider portal.
- Assign a six-character ELD identifier to the exact Fleet AI hardware/software model and version.
- Generate and protect the provider authentication private key and public certificate.
- Record product name, model number, software version, provider contact information, and public support contact.

## Required implementation evidence

- Complete every applicable case in the official FMCSA ELD Test Plan and Procedures.
- Replay carrier-selected HOS profiles against regulator-reviewed examples, including home-terminal day boundaries and daylight-saving transitions; obtain independent sign-off before enabling the HOS validation gate.
- Validate simple, edited, unidentified-driver, co-driver, malfunction, diagnostic, power-cycle, and eight-day files with the FMCSA File Validator.
- Complete test web-service and email transfers and review the files in Web eRODS.
- Verify the Android roadside display shows the current 24-hour period plus the previous seven consecutive days.
- Verify automatic driving at 5 mph, six-minute stopped transition, one-hour intermediate records, engine synchronization, GPS, odometer, engine hours, VIN, and power cycles on each supported J1939 gateway/tablet combination.
- Verify offline recording, restart recovery, sequence continuity, storage integrity, and eventual transfer after connectivity returns.
- Complete an independent ELD compliance review and an automotive cybersecurity penetration test.

## Submission package

- Product screenshot.
- Driver and motor-carrier user manual.
- Step-by-step roadside transfer instructions for web services and email.
- Malfunction summary and driver/carrier resolution instructions.
- Authentication-value validation procedure matching the deployed signing implementation.
- Signed certifying statement describing the completed tests.
- Public key certificate.

## Release control

- Register and self-certify each model and software version.
- Confirm the exact version is visible on the FMCSA Registered Devices List before production use.
- Treat changes to HOS logic, event formatting, transfer, authentication, hardware interface, or certified version as controlled compliance releases requiring regression testing and listing review.
- Monitor FMCSA transfer success reports and resolve warnings/errors before they threaten continued listing.
