"use strict";

// Financial commands accept canonical decimal text, never locale-formatted or
// floating-point values. Legacy order importers retain their existing parser.
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

function assertMinor(value) {
  if (!Number.isSafeInteger(value)) throw new TypeError("Amount must be safe integer minor units");
  return value;
}

function toMinor(decimal) {
  if (typeof decimal !== "string" || !/^-?\d+(?:\.\d{1,2})?$/.test(decimal)) {
    throw new TypeError("Amount must be decimal text with at most two fractional digits");
  }
  const negative = decimal.startsWith("-");
  const [whole, fraction = ""] = decimal.replace(/^-/, "").split(".");
  const magnitude = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (magnitude > MAX_MINOR) throw new RangeError("Amount exceeds safe range");
  return Number(negative ? -magnitude : magnitude);
}

function fromMinor(value) {
  const amount = BigInt(assertMinor(value));
  const magnitude = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

function sumMinor(values) {
  const sum = values.reduce((total, value) => total + BigInt(assertMinor(value)), 0n);
  if (sum > MAX_MINOR || sum < -MAX_MINOR) throw new RangeError("Total exceeds safe range");
  return Number(sum);
}

// Basis points: 500 = 5%. Round once per posted line, halves away from zero.
function percentageMinor(value, basisPoints) {
  assertMinor(value);
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
    throw new RangeError("Percentage must be 0..10000 basis points");
  }
  const product = BigInt(value) * BigInt(basisPoints);
  const magnitude = product < 0n ? -product : product;
  const rounded = (magnitude + 5000n) / 10000n;
  return Number(product < 0n ? -rounded : rounded);
}

module.exports = { assertMinor, toMinor, fromMinor, sumMinor, percentageMinor };
