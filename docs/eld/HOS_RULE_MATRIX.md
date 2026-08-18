# Fleet AI HOS Rule Matrix

Reviewed against government sources on 2026-08-18. This engineering matrix is not legal advice and does not replace carrier safety counsel or the official FMCSA test process.

## Supported base profiles

| Profile | Off-duty reset | Driving | Driving window | Driving break | Cycle |
| --- | ---: | ---: | ---: | ---: | ---: |
| `FEDERAL_PROPERTY_60_7` | 10 consecutive hours | 11 hours | 14 consecutive hours | 30 consecutive non-driving minutes after 8 cumulative driving hours | 60 on-duty hours / 7 days |
| `FEDERAL_PROPERTY_70_8` | 10 consecutive hours | 11 hours | 14 consecutive hours | 30 consecutive non-driving minutes after 8 cumulative driving hours | 70 on-duty hours / 8 days |
| `CA_INTRASTATE_PROPERTY_80_8` | 10 consecutive hours | 12 hours | 16 hours | California has no equivalent 30-minute HOS break for this profile; employment meal/rest rules require separate employer review | 80 on-duty hours / 8 days |

Federal sources:

- 49 CFR 395.3: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-395/subpart-A/section-395.3
- FMCSA HOS summary: https://www.fmcsa.dot.gov/regulations/hours-service/summary-hours-service-regulations
- Sleeper berth and other exceptions, 49 CFR 395.1: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-395/subpart-A/section-395.1

California sources:

- California Vehicle Code 34501.2: https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=VEH&sectionNum=34501.2.
- California Commercial Driver Handbook: https://www.dmv.ca.gov/portal/handbook/commercial-driver-handbook/section-1-introduction/
- California transportation-industry wage order: https://dir.ca.gov/t8/11090.html
- CHP interstate/intrastate HOS comparison: https://www.chp.ca.gov/CommercialVehicleSectionSite/Documents/CVSS%202021%20ELDs%20and%20Hours-of-Service.pdf

## Rule selection

- Use a federal property profile when the shipment is interstate commerce, including freight that originated outside California or is destined outside California.
- Use the California intrastate profile only when the operation and freight qualify as California intrastate commerce and no federal rule supersedes it.
- The 60/7 profile applies when the carrier does not operate CMVs every day of the week. The 70/8 profile applies when it does.
- Cycle totals use the carrier-configured 24-hour home-terminal boundary. They are not calculated as a simple rolling 168- or 192-hour window from the current minute.
- Do not infer short-haul, adverse-driving, emergency, agricultural, utility, oilfield, Alaska, passenger-carrier, or pilot-program eligibility from GPS or duty records.
- FMCSA's 2026 flexible-sleeper and split-duty pilot programs are not general rules. Fleet AI must not apply pilot relief unless the driver/carrier is formally participating and a separately validated profile is enabled.

## Exceptions still gated

Fleet AI currently does not automatically grant time under:

- Federal split sleeper berth (at least 7 consecutive hours in sleeper plus at least 2 hours off/sleeper, totaling at least 10).
- California intrastate split sleeper treatment, which the California handbook describes separately with an 8-hour minimum long period.
- Adverse driving conditions (up to two additional hours when the regulatory definition and conditions are met).
- Short-haul exceptions.
- California agricultural and other specialized intrastate exceptions.
- Passenger-carrier rules.
- Alaska rules or approved FMCSA pilot programs.

Until these are implemented and independently validated, the ordinary profile remains conservative and the tablet tells the driver that exception relief is not included.

## Tablet and carrier controls

Government requirements also include:

- Current 24-hour period plus previous seven consecutive days available to the driver and roadside official.
- Daily graph grid, header, detailed records, driver certification, and annotations for edits.
- Portable tablet mounted in a fixed position and visible to the seated driver.
- Onboard transfer instructions, malfunction instructions, and at least eight days of blank graph-grid records.
- Six-month carrier retention plus a six-month backup on a separate device.
- Driver login using a unique account tied to valid license identity.

Sources:

- FMCSA ELD checklist: https://www.fmcsa.dot.gov/hours-service/elds/eld-checklist-english-version
- 49 CFR 395.22: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-395/subpart-B/section-395.22
- 49 CFR 395.34: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-395/subpart-B/section-395.34
- 49 CFR 395.8: https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-395/subpart-A/section-395.8
