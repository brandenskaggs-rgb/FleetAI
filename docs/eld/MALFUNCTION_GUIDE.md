# Fleet AI ELD Malfunction and Diagnostic Guide

Fleet AI records detected and cleared events for the standard ELD codes.

| Code | Area | Driver action | Carrier action |
| --- | --- | --- | --- |
| P | Power | Notify the carrier and use the required backup process if records are affected. | Inspect tablet/gateway power and repair or replace within the regulatory window. |
| E | Engine synchronization | Verify the gateway and diagnostic connection; notify the carrier if it remains active. | Restore engine power, motion, miles, and engine-hours acquisition. |
| T | Timing | Keep the device connected to trusted network/GPS time and notify the carrier. | Correct device time source and verify UTC accuracy. |
| L | Positioning | Check location permission and antenna view; notify the carrier. | Restore compliant positioning and validate accumulated in-motion loss. |
| R | Data recording | Stop relying on the device for records and begin the backup procedure. | Restore storage integrity and retained records or replace the device. |
| S | Data transfer | Retry the transfer and retain the displayed error. | Restore web-service/email operation and verify the next monitoring checks. |
| O | Unidentified driving | Review and claim only records that belong to the authenticated driver. | Assign or annotate unresolved unidentified driving records. |

When an ELD malfunction prevents accurate HOS recording or presentation, the driver must notify the carrier and reconstruct/use paper records as required by 49 CFR 395.34. The carrier generally has eight days to repair, service, or replace the ELD, subject to the regulation's extension process.
