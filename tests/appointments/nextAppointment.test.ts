import assert from "node:assert/strict";
import test from "node:test";
import { prepareNextAppointmentLookup } from "../../src/appointments/nextAppointment.js";
import { CallSession } from "../../src/calls/callSession.js";

test("adds the caller number to a next-appointment lookup", () => {
  const prepared = prepareNextAppointmentLookup(session(), {
    name: "GET_NEXT_APPOINTMENT",
    arguments: { firstName: "Kumar" }
  });

  assert.deepEqual(prepared.arguments, {
    firstName: "Kumar",
    fromNumber: "+17030175781"
  });
});

test("does not modify unrelated tool requests", () => {
  const request = {
    name: "GET_INSURANCE_POLICY",
    arguments: {}
  };

  assert.equal(prepareNextAppointmentLookup(session(), request), request);
});

function session(): CallSession {
  return {
    callSid: "CA-test",
    officeCode: "OFC001",
    fromNumber: "+17030175781",
    startedAt: "2026-08-17T00:00:00.000Z",
    lastActivityAt: "2026-08-17T00:00:00.000Z",
    patientVerified: false,
    transcript: [],
    collectedFields: {},
    lastToolResults: {},
    pendingActions: {},
    appointmentSelections: {}
  };
}
