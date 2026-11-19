"use strict";

function isOrgAvailable(org) {
  return Boolean(org) && !org.deletedAt && String(org.status || "").trim().toUpperCase() !== "DELETED";
}

module.exports = { isOrgAvailable };
