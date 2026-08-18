-- VIN belongs to the vehicle capability record, not every telemetry sample.
-- Remove historical duplicates without changing the sensor measurements.
UPDATE "TelemetrySample"
SET "raw" = "raw" - 'vin' - 'VIN'
WHERE "raw" ? 'vin' OR "raw" ? 'VIN';

