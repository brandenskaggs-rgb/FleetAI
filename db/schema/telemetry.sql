-- Telemetry table schema (simple outline)
CREATE TABLE IF NOT EXISTS telemetry (
    ts TIMESTAMP NOT NULL,
    vehicle_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (ts, vehicle_id, metric)
);
