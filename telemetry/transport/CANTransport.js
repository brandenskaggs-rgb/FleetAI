class CANTransport {
  constructor() {
    this.onFrame = null;
    this.onError = null;
    this.connected = false;
  }

  async connect() {
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
  }

  async start() {
    if (!this.connected) await this.connect();
  }

  stop() {
    this.connected = false;
  }

  pushFrame(frame) {
    if (this.onFrame) this.onFrame(frame);
  }
}

module.exports = CANTransport;
