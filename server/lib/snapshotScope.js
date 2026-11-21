"use strict";

// A current ownership lookup cannot establish who owned an older sample.
function scopedSnapshot(snapshot, orgId, vehicleId) {
  if (!orgId || !vehicleId || snapshot?.vehicleId !== vehicleId) return null;
  const owners = [snapshot.orgId, snapshot.metrics?.orgId].filter(id => id != null);
  return owners.length && owners.every(id => id === orgId) ? snapshot : null;
}

module.exports = { scopedSnapshot };
