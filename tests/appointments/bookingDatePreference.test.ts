import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBookingDatePreference } from "../../src/workflows/bookAppointment/bookingDatePreference.js";

test("resolves day after tomorrow using the office-local current date", () => {
  assert.equal(
    normalizeBookingDatePreference("day after tomorrow", "America/Los_Angeles", "2026-09-16T12:00:00.000Z"),
    "09/18/2026"
  );
});

test("accepts the article form of day after tomorrow", () => {
  assert.equal(
    normalizeBookingDatePreference("the day after tomorrow", "America/Los_Angeles", "2026-09-16T12:00:00.000Z"),
    "09/18/2026"
  );
});
