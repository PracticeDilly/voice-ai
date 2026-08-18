import assert from "node:assert/strict";
import test from "node:test";
import { invalidateAppointmentLookupCacheAfterConfirmation } from "../../src/appointments/appointmentLookupCache.js";
import { CallSession } from "../../src/calls/callSession.js";

test("removes stale next-appointment lookup after successful confirmation", () => {
  const callSession = session();

  invalidateAppointmentLookupCacheAfterConfirmation(callSession, "CONFIRM_APPOINTMENT", {
    name: "CONFIRM_APPOINTMENT",
    ok: true
  });

  assert.equal(callSession.lastToolResults.GET_NEXT_APPOINTMENT, undefined);
  assert.deepEqual(callSession.lastToolResults.CONFIRM_APPOINTMENT, { ok: true });
});

test("keeps lookup cache when confirmation fails", () => {
  const callSession = session();

  invalidateAppointmentLookupCacheAfterConfirmation(callSession, "CONFIRM_APPOINTMENT", {
    name: "CONFIRM_APPOINTMENT",
    ok: false
  });

  assert.notEqual(callSession.lastToolResults.GET_NEXT_APPOINTMENT, undefined);
});

test("keeps lookup cache for unrelated tools", () => {
  const callSession = session();

  invalidateAppointmentLookupCacheAfterConfirmation(callSession, "GET_NEXT_APPOINTMENT", {
    name: "GET_NEXT_APPOINTMENT",
    ok: true
  });

  assert.notEqual(callSession.lastToolResults.GET_NEXT_APPOINTMENT, undefined);
});

function session(): CallSession {
  return {
    callSid: "CA-test",
    officeCode: "OFC001",
    startedAt: "2026-08-17T00:00:00.000Z",
    lastActivityAt: "2026-08-17T00:00:00.000Z",
    patientVerified: true,
    transcript: [],
    collectedFields: {},
    pendingActions: {},
    appointmentSelections: {},
    lastToolResults: {
      GET_NEXT_APPOINTMENT: {
        ok: true,
        data: {
          upcomingAppointments: [
            {
              appointmentId: 501,
              confirmStatus: 20
            }
          ]
        }
      },
      CONFIRM_APPOINTMENT: {
        ok: true
      }
    }
  };
}
