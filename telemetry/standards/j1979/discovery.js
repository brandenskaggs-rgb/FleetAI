function decodeSupportedPids(bytes, basePid) {
  const supported = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      const isSet = (byte & (1 << (7 - bit))) !== 0;
      if (isSet) {
        const pid = basePid + (i * 8) + bit + 1;
        supported.push(pid.toString(16).toUpperCase().padStart(2, "0"));
      }
    }
  }
  return supported;
}

module.exports = {
  decodeSupportedPids
};
