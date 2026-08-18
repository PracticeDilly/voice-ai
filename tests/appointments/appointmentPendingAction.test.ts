import assert from "node:assert/strict";
import test from "node:test";
import {
  consumePendingAppointmentConfirmation,
  prepareAppointmentConfirmation,
  promotePendingAppointmentConfirmation,
  syncPendingAppointmentConfirmation
} from "../../src/appointments/appointmentPendingAction.js";
import { CallSession } from "../../src/calls/callSession.js";

test("creates awaiting pending confirmation from confirm-intent appointment lookup", () => {
  const callSession = session();

  syncPendingAppointmentConfirmation(callSession, "GET_NEXT_APPOINTMENT", {
    name: "GET_NEXT_APPOINTMENT",
    ok: true,
    data: {
      appointmentId: 501,
      alreadyConfirmed: false
    }
  }, "CONFIRM_APPOINTMENT");

  assert.deepEqual(callSession.pendingActions.CONFIRM_APPOINTMENT?.appointmentId, 501);
  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT?.status, "AWAITING_CALLER_CONFIRMATION");
});

test("does not create pending confirmation for read-only next appointment intent", () => {
  const callSession = session();

  syncPendingAppointmentConfirmation(callSession, "GET_NEXT_APPOINTMENT", {
    name: "GET_NEXT_APPOINTMENT",
    ok: true,
    data: {
      appointmentId: 501,
      alreadyConfirmed: false
    }
  }, "NEXT_APPOINTMENT");

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT, undefined);
});

test("does not create pending confirmation for non-confirm intent names containing confirm text", () => {
  const callSession = session();

  syncPendingAppointmentConfirmation(callSession, "GET_NEXT_APPOINTMENT", {
    name: "GET_NEXT_APPOINTMENT",
    ok: true,
    data: {
      appointmentId: 501,
      metadata: {
        alreadyConfirmed: false
      }
    }
  }, "DO_NOT_CONFIRM_APPOINTMENT");

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT, undefined);
});

test("promotes pending confirmation after structured caller confirmation", () => {
  const callSession = session();
  callSession.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId: 501,
    status: "AWAITING_CALLER_CONFIRMATION",
    createdAt: "2026-08-17T00:00:00.000Z"
  };
  callSession.collectedFields.callerConfirmedSelectedAppointment = true;

  promotePendingAppointmentConfirmation(callSession);

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT.status, "READY_TO_EXECUTE");
});

test("promotes pending confirmation from structured tool argument", () => {
  const callSession = session();
  callSession.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId: 501,
    status: "AWAITING_CALLER_CONFIRMATION",
    createdAt: "2026-08-17T00:00:00.000Z"
  };

  promotePendingAppointmentConfirmation(callSession, {
    name: "CONFIRM_APPOINTMENT",
    arguments: {
      appointmentId: 501,
      callerConfirmedSelectedAppointment: true
    }
  });

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT.status, "READY_TO_EXECUTE");
});

test("consumes pending confirmation after successful confirmation", () => {
  const callSession = session();
  callSession.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId: 501,
    status: "READY_TO_EXECUTE",
    createdAt: "2026-08-17T00:00:00.000Z"
  };
  callSession.collectedFields.callerConfirmedSelectedAppointment = true;

  consumePendingAppointmentConfirmation(callSession, "CONFIRM_APPOINTMENT", {
    name: "CONFIRM_APPOINTMENT",
    ok: true
  });

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT, undefined);
  assert.equal(callSession.collectedFields.callerConfirmedSelectedAppointment, undefined);
});

test("adds explicit confirmation flag after pending confirmation is ready", () => {
  const callSession = session();
  callSession.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId: 501,
    status: "READY_TO_EXECUTE",
    createdAt: "2026-08-17T00:00:00.000Z"
  };

  const prepared = prepareAppointmentConfirmation(callSession, {
    name: "CONFIRM_APPOINTMENT",
    arguments: {
      appointmentId: 501
    }
  });

  assert.equal(prepared.arguments.callerConfirmedSelectedAppointment, true);
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
    lastToolResults: {},
    pendingActions: {}
  };
}
