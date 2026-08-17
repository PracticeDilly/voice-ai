import assert from "node:assert/strict";
import test from "node:test";
import { validateAppointmentConfirmation } from "../../src/appointments/appointmentConfirmation.js";
import { ToolRequest } from "../../src/backend/springBootClient.js";
import { CallSession } from "../../src/calls/callSession.js";

test("allows confirmation for the backend-selected appointment", () => {
  assert.equal(validateAppointmentConfirmation(session({
    allowedActions: ["CONFIRM_APPOINTMENT"],
    selectedAppointmentId: 501,
    alreadyConfirmed: false
  }), confirmation(501)), undefined);
});

test("rejects confirmation when the backend did not allow it", () => {
  assert.match(validateAppointmentConfirmation(session({
    allowedActions: [],
    selectedAppointmentId: 501,
    alreadyConfirmed: false
  }), confirmation(501)) ?? "", /not allowed/);
});

test("rejects confirmation for an already-confirmed appointment", () => {
  assert.match(validateAppointmentConfirmation(session({
    allowedActions: ["CONFIRM_APPOINTMENT"],
    selectedAppointmentId: 501,
    alreadyConfirmed: true
  }), confirmation(501)) ?? "", /already confirmed/);
});

test("rejects an appointment id that differs from the backend selection", () => {
  assert.match(validateAppointmentConfirmation(session({
    allowedActions: ["CONFIRM_APPOINTMENT"],
    selectedAppointmentId: 501,
    alreadyConfirmed: false
  }), confirmation(900)) ?? "", /does not match/);
});

test("does not restrict read-only appointment lookup", () => {
  assert.equal(validateAppointmentConfirmation(session({
    allowedActions: [],
    selectedAppointmentId: undefined,
    alreadyConfirmed: undefined
  }), {
    name: "GET_NEXT_APPOINTMENT",
    arguments: {}
  }), undefined);
});

function confirmation(appointmentId: unknown): ToolRequest {
  return {
    name: "CONFIRM_APPOINTMENT",
    arguments: { appointmentId }
  };
}

function session(input: {
  allowedActions: string[];
  selectedAppointmentId: unknown;
  alreadyConfirmed: boolean | undefined;
}): CallSession {
  return {
    callSid: "CA-test",
    officeCode: "OFC001",
    startedAt: "2026-08-17T00:00:00.000Z",
    lastActivityAt: "2026-08-17T00:00:00.000Z",
    patientVerified: true,
    transcript: [],
    collectedFields: {},
    lastToolResults: {},
    workflowState: {
      contractVersion: 1,
      workflow: "NEXT_APPOINTMENT",
      state: "COMPLETED",
      allowedActions: input.allowedActions,
      context: {
        selectedAppointmentId: input.selectedAppointmentId,
        alreadyConfirmed: input.alreadyConfirmed
      }
    }
  };
}
