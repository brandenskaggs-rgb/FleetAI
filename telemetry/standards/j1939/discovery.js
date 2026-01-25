class J1939Discovery {
  constructor() {
    this.pgns = new Set();
    this.spns = new Set();
  }

  registerPgn(pgn) {
    this.pgns.add(pgn);
  }

  registerSpns(list) {
    if (!Array.isArray(list)) return;
    list.forEach((spn) => this.spns.add(spn));
  }

  snapshot() {
    return {
      pgns: Array.from(this.pgns),
      spns: Array.from(this.spns)
    };
  }
}

module.exports = {
  J1939Discovery
};
