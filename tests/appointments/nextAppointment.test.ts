import assert from "node:assert/strict";
import test from "node:test";
import { CallSession } from "../../src/calls/callSession.js";
import { NextAppointmentToolAdapter } from "../../src/workflows/nextAppointment/nextAppointmentToolAdapter.js";

const toolAdapter = new NextAppointmentToolAdapter();

test("adds the caller number to a next-appointment lookup", () => {
  const prepared = toolAdapter.prepareTool(session(), {
    name: "GET_NEXT_APPOINTMENT",
    arguments: { firstName: "Kumar" }
  });

  assert.deepEqual(prepared.arguments, {
    firstName: "Kumar",
    fromNumber: "+17030175781"
  });
});

test("canonicalizes next-appointment lookup fields before sending them", () => {
  const prepared = toolAdapter.prepareTool(session(), {
    name: "GET_NEXT_APPOINTMENT",
    arguments: {
      firstName: "  Kim  ",
      lastName: " Miller ",
      dateOfBirth: " 10/18/1999 ",
      fromNumber: " +17030175781 "
    }
  });

  assert.deepEqual(prepared.arguments, {
    firstName: "Kim",
    lastName: "Miller",
    dob: "10/18/1999",
    fromNumber: "+17030175781"
  });
});

test("omits blank caller-derived fields from a next-appointment lookup", () => {
  const prepared = toolAdapter.prepareTool(session(), {
    name: "GET_NEXT_APPOINTMENT",
    arguments: {
      firstName: "   ",
      dob: "",
      fromNumber: "   "
    }
  });

  assert.deepEqual(prepared.arguments, {
    fromNumber: "+17030175781"
  });
});

test("does not modify unrelated tool requests", () => {
  const request = {
    name: "GET_INSURANCE_POLICY",
    arguments: {}
  };

  assert.equal(toolAdapter.prepareTool(session(), request), request);
});

function session(): CallSession {
  return {
    callSid: "CA-test",
    officeCode: "OFC001",
    fromNumber: "+17030175781",
    startedAt: "2026-08-17T00:00:00.000Z",
    lastActivityAt: "2026-08-17T00:00:00.000Z",
    transcript: [],
    collectedFields: {},
    lastToolResults: {},
    pendingActions: {},
    appointmentSelections: {}
  };
}
