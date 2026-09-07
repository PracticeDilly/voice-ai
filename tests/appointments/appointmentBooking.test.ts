import assert from "node:assert/strict";
import test from "node:test";
import { CallSession } from "../../src/calls/callSession.js";
import { BookAppointmentToolAdapter } from "../../src/workflows/bookAppointment/bookAppointmentToolAdapter.js";

test("prepares booking request with caller number and collected conversational fields", () => {
  const callSession = session();
  callSession.fromNumber = "+15551234567";
  callSession.collectedFields.firstName = "Priya";
  callSession.collectedFields.dob = "1990-04-15";
  callSession.collectedFields.bookingReason = "tooth pain";
  callSession.collectedFields.datePreference = "09/04/2026";
  callSession.collectedFields.timePreference = "morning";

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      providerName: "Dr. Shah"
    }
  });

  assert.equal(prepared.arguments.firstName, "Priya");
  assert.equal(prepared.arguments.dob, "1990-04-15");
  assert.equal(prepared.arguments.bookingReason, "tooth pain");
  assert.equal(prepared.arguments.providerName, "Dr. Shah");
  assert.equal(prepared.arguments.datePreference, "09/04/2026");
  assert.equal(prepared.arguments.timePreference, "morning");
  assert.equal(prepared.arguments.fromNumber, "+15551234567");
});

test("normalizes model booking date preferences", () => {
  const callSession = session();
  callSession.startedAt = "2026-09-07T07:35:00.000Z";
  callSession.officeContext = {
    officeCode: "OFC001",
    timezone: "America/Los_Angeles"
  };

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      firstName: "Nancy",
      lastName: "Jones",
      dob: "04/01/2000",
      bookingReason: "teeth whitening",
      datePreference: "Wednesday",
      timePreference: "morning"
    }
  });

  assert.equal(prepared.arguments.bookingReason, "teeth whitening");
  assert.equal(prepared.arguments.datePreference, "09/09/2026");
  assert.equal(prepared.arguments.timePreference, "morning");
});

test("rejects final booking before backend confirmation state", () => {
  const error = new BookAppointmentToolAdapter().validateTool(session(), {
    name: "BOOK_APPOINTMENT",
    arguments: {
      callerConfirmedBooking: true,
      slotDate: "09/04/2026",
      slotTime: "09:00 AM"
    }
  });

  assert.match(error ?? "", /backend has returned a booking confirmation step/);
});

test("allows final booking after backend confirmation state with selected slot", () => {
  const callSession = session();
  callSession.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "REQUIRES_CONFIRMATION",
    context: {
      slotDate: "09/04/2026",
      slotTime: "09:00 AM"
    }
  };

  const error = new BookAppointmentToolAdapter().validateTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      callerConfirmedBooking: true
    }
  });

  assert.equal(error, undefined);
});

function session(): CallSession {
  return {
    callSid: "CA-test",
    officeCode: "OFC001",
    startedAt: "2026-09-03T00:00:00.000Z",
    lastActivityAt: "2026-09-03T00:00:00.000Z",
    transcript: [],
    collectedFields: {},
    lastToolResults: {},
    pendingActions: {},
    appointmentSelections: {}
  };
}
