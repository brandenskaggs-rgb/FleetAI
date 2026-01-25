const { createTelemetrySchema, mergeTelemetry } = require("./telemetrySchema");

class TelemetryManager {
  constructor(opts = {}) {
    this.vehicleId = opts.vehicleId || "";
    this.deviceId = opts.deviceId || "";
    this.vehicleClass = opts.vehicleClass || "heavy";
    this.adapters = [];
    this.telemetry = createTelemetrySchema();
    this.telemetry.vehicleId = this.vehicleId;
    this.telemetry.deviceId = this.deviceId;
    this.telemetry.vehicleClass = this.vehicleClass;
    this.telemetry.meta.supportedStandards = [];
    this.onUpdate = opts.onUpdate || null;
  }

  registerAdapter(adapter) {
    if (!adapter || typeof adapter.handleFrame !== "function") {
      throw new Error("Adapter must implement handleFrame(frame, context)");
    }
    this.adapters.push(adapter);
    if (adapter.standard && !this.telemetry.meta.supportedStandards.includes(adapter.standard)) {
      this.telemetry.meta.supportedStandards.push(adapter.standard);
    }
  }

  handleFrame(frame) {
    this.telemetry.meta.busHealth.lastFrameAt = new Date().toISOString();
    for (const adapter of this.adapters) {
      const update = adapter.handleFrame(frame, {
        vehicleId: this.vehicleId,
        deviceId: this.deviceId
      });
      if (update) {
        mergeTelemetry(this.telemetry, update);
      }
    }
    this.telemetry.timestamp = new Date().toISOString();
    this.telemetry.meta.confidenceScore = this.computeConfidence();
    if (this.onUpdate) this.onUpdate(this.telemetry);
    return this.telemetry;
  }

  handleError() {
    this.telemetry.meta.busHealth.errorCount += 1;
    this.telemetry.meta.confidenceScore = this.computeConfidence();
  }

  handleDrop() {
    this.telemetry.meta.busHealth.dropCount += 1;
    this.telemetry.meta.confidenceScore = this.computeConfidence();
  }

  computeConfidence() {
    const errors = this.telemetry.meta.busHealth.errorCount;
    const drops = this.telemetry.meta.busHealth.dropCount;
    const penalty = Math.min(0.8, (errors + drops) / 100);
    return Math.max(0, 1 - penalty);
  }

  exportSnapshot() {
    return JSON.parse(JSON.stringify(this.telemetry));
  }
}

module.exports = {
  TelemetryManager
};
