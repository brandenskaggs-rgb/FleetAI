# Fleet AI ELD Roadside Data Transfer Guide

Fleet AI will certify the telematics option: FMCSA web services and email. Both methods must pass before registration.

## Driver workflow

1. Open Logbook and select Roadside Inspection.
2. Review the current day and previous seven days.
3. Select Transfer ELD Records.
4. Enter the output-file comment supplied by the safety official, if any.
5. Choose Web Services. If instructed or the first method fails, choose Email.
6. Keep the result screen open and provide the transfer confirmation or error to the official.

## Provider dependencies

The endpoint, WSDL, FMCSA public key, email address, client-certificate requirements, and test flags are distributed through the FMCSA ELD Provider Portal. They must not be guessed or copied from another provider.

Required production secrets:

- `FMCSA_ELD_AUTH_PRIVATE_KEY`
- `FMCSA_ELD_CLIENT_CERT`
- `FMCSA_ELD_CLIENT_KEY`
- `FMCSA_ELD_WEBSERVICE_URL`
- `FMCSA_ELD_EMAIL_ADDRESS`

Fleet AI currently generates the standard comma-delimited file and integrity checks. Production web-service/email submission remains blocked until provider-portal credentials are installed and the official transfer tests pass.
