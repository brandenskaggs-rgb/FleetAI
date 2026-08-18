# Extended OBD profiles

Fleet AI polls SAE J1979 Mode 01 signals only when the ECU advertises them. Manufacturer-specific data uses a separate, read-only profile engine so an unverified formula cannot contaminate telemetry or ML features.

## Profile requirements

Profiles live in `app/src/main/assets/obd/extended_pid_profiles.json`. Every sensor must provide:

- a physical ECU request header;
- a Mode 21 or Mode 22 read command;
- the matching positive response prefix;
- the expected data byte count;
- a constrained decode formula;
- engineering units and a credible valid range;
- polling interval and priority;
- an HTTPS source and a statement of what that source establishes.

The app rejects write, reset, security-access, routine-control, coding, and reprogramming services. It also rejects functional broadcast headers, mismatched response prefixes, formulas that reference unavailable bytes, and decoded values outside the declared range.

## 2010 Camaro status

The bundled `gm-gmx521-2010-llt` profile identifies a 2010 Chevrolet Camaro with VIN engine code `V` as the 3.6L LLT/OBDG02 family. This match comes from General Motors' public 2010 OBD grouping matrix. Its sensor list intentionally remains empty because the public matrix and diagnostic summary document do not publish the scan-tool request identifiers and byte formulas.

Authoritative definitions can be added when obtained from licensed GM Service Information, an OEM-authorized data provider, or a user-owned custom PID export that includes the command, header, byte layout, and formula. A screenshot containing only sensor names or displayed values is not sufficient to create a safe definition.

## Formula language

Supported operations are arithmetic, modulo, shifts, bitwise operations, comparisons, parentheses, byte variables `A` through `ZZ`, and these functions:

- `abs`, `min`, `max`
- `signed8`, `signed16`, `signed32`
- `getbit`
- `if`
- `float32`, `float64`

Formulas are parsed by Fleet AI. They are never passed to a runtime evaluator.
