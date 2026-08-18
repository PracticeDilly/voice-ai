import assert from "node:assert/strict";
import test from "node:test";
import { validateAppointmentConfirmation } from "../../src/appointments/appointmentConfirmation.js";
import { ToolRequest } from "../../src/backend/springBootClient.js";
import { CallSession } from "../../src/calls/callSession.js";

test("allows confirmation for the backend-selected appointment", () => {
  assert.equal(validateAppointmentConfirmation(session({
    workflow: "CONFIRM_APPOINTMENT",
    allowedActions: ["CONFIRM_APPOINTMENT"],
    selectedAppointmentId: 501,
    alreadyConfirmed: false,
    pendingAppointmentId: 501,
    pendingStatus: "READY_TO_EXECUTE"
  }), confirmation(501)), undefined);
});

test("rejects confirmation without a pending confirmation action", () => {
  assert.match(validateAppointmentConfirmation(session({
    workflow: "CONFIRM_APPOINTMENT",
    allowedActions: ["CONFIRM_APPOINTMENT"],
    selectedAppointmentId: 501,
    alreadyConfirmed: false
  }), confirmation(501)) ?? "", /pending confirmation action/);
});

test("rejects confirmation before caller authorization", () => {
  assert.match(validateAppointmentConfirmation(session({
    workflow: "NEXT_APPOINTMENT",
    allowedActions: ["CONFIRM_APPOINTMENT"],
    selectedAppointmentId: 501,
    alreadyConfirmed: false,
    pendingAppointmentId: 501,
    pendingStatus: "AWAITING_CALLER_CONFIRMATION"
  }), confirmation(501)) ?? "", /explicit caller confirmation/);
});

test("rejects confirmation for an already-confirmed appointment", () => {
  assert.match(validateAppointmentConfirmation(session({
    workflow: "CONFIRM_APPOINTMENT",
    allowedActions: ["CONFIRM_APPOINTMENT"],
    selectedAppointmentId: 501,
    alreadyConfirmed: true,
    pendingAppointmentId: 501,
    pendingStatus: "READY_TO_EXECUTE"
  }), confirmation(501)) ?? "", /already confirmed/);
});

test("rejects an appointment id that differs from the backend selection", () => {
  assert.match(validateAppointmentConfirmation(session({
    workflow: "CONFIRM_APPOINTMENT",
    allowedActions: ["CONFIRM_APPOINTMENT"],
    selectedAppointmentId: 501,
    alreadyConfirmed: false,
    pendingAppointmentId: 501,
    pendingStatus: "READY_TO_EXECUTE"
  }), confirmation(900)) ?? "", /does not match/);
});

test("does not restrict read-only appointment lookup", () => {
  assert.equal(validateAppointmentConfirmation(session({
    workflow: "NEXT_APPOINTMENT",
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
  workflow: string;
  allowedActions: string[];
  selectedAppointmentId: unknown;
  alreadyConfirmed: boolean | undefined;
  pendingAppointmentId?: unknown;
  pendingStatus?: "AWAITING_CALLER_CONFIRMATION" | "READY_TO_EXECUTE";
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
    pendingActions: input.pendingAppointmentId ? {
      CONFIRM_APPOINTMENT: {
        appointmentId: input.pendingAppointmentId,
        status: input.pendingStatus ?? "AWAITING_CALLER_CONFIRMATION",
        createdAt: "2026-08-17T00:00:00.000Z"
      }
    } : {},
    appointmentSelections: {},
    workflowState: {
      contractVersion: 1,
      workflow: input.workflow,
      state: "COMPLETED",
      allowedActions: input.allowedActions,
      context: {
        selectedAppointmentId: input.selectedAppointmentId,
        alreadyConfirmed: input.alreadyConfirmed
      }
    }
  };
}
