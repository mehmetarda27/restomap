"use strict";

function applyBrandEnvCompatibility(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("RESTOMAP_")) {
      const legacyKey = `DELIVERA_${key.slice("RESTOMAP_".length)}`;
      if (env[legacyKey] === undefined) env[legacyKey] = value;
    }
    if (key.startsWith("DELIVERA_")) {
      const currentKey = `RESTOMAP_${key.slice("DELIVERA_".length)}`;
      if (env[currentKey] === undefined) env[currentKey] = value;
    }
  }
  return env;
}

module.exports = { applyBrandEnvCompatibility };
