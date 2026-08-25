import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeConfirmAppointmentPendingAction,
  hydrateConfirmAppointmentSelections,
  prepareConfirmAppointmentTool,
  promoteConfirmAppointmentPendingAction,
  syncConfirmAppointmentFromLookup
} from "../../src/workflows/confirmAppointment/confirmAppointmentPendingAction.js";
import { CallSession } from "../../src/calls/callSession.js";

test("creates awaiting pending confirmation from confirm-intent appointment lookup", () => {
  const callSession = session();

  syncConfirmAppointmentFromLookup(callSession, "GET_NEXT_APPOINTMENT", {
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

  syncConfirmAppointmentFromLookup(callSession, "GET_NEXT_APPOINTMENT", {
    name: "GET_NEXT_APPOINTMENT",
    ok: true,
    data: {
      appointmentId: 501,
      alreadyConfirmed: false
    }
  }, "NEXT_APPOINTMENT");

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT, undefined);
});

test("stores multiple confirmable options without selecting the first appointment", () => {
  const callSession = session();

  syncConfirmAppointmentFromLookup(callSession, "GET_NEXT_APPOINTMENT", {
    name: "GET_NEXT_APPOINTMENT",
    ok: true,
    data: {
      upcomingAppointments: [
        appointment(501, "9:00 AM, Thu, Aug 20 2026"),
        appointment(502, "9:20 AM, Fri, Aug 21 2026"),
        appointment(503, "10:00 AM, Mon, Aug 24 2026")
      ]
    }
  }, "CONFIRM_APPOINTMENT");

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT, undefined);
  assert.deepEqual(
    callSession.appointmentSelections.CONFIRM_APPOINTMENT?.options.map((option) => option.appointmentId),
    [501, 502, 503]
  );
});

test("selects a different appointment from stored confirmable options before confirmation", () => {
  const callSession = session();
  callSession.currentIntent = "CONFIRM_APPOINTMENT";
  callSession.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId: 501,
    status: "AWAITING_CALLER_CONFIRMATION",
    createdAt: "2026-08-17T00:00:00.000Z"
  };
  callSession.appointmentSelections.CONFIRM_APPOINTMENT = {
    createdAt: "2026-08-17T00:00:00.000Z",
    options: [
      option(501, "9:00 AM, Thu, Aug 20 2026"),
      option(502, "9:20 AM, Fri, Aug 21 2026")
    ]
  };

  promoteConfirmAppointmentPendingAction(callSession, {
    name: "CONFIRM_APPOINTMENT",
    arguments: {
      appointmentId: 502
    }
  });

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT.appointmentId, 502);
  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT.status, "AWAITING_CALLER_CONFIRMATION");
});

test("selects a confirmable appointment by structured appointment date", () => {
  const callSession = session();
  callSession.currentIntent = "CONFIRM_APPOINTMENT";
  callSession.collectedFields.selectedAppointmentDate = "9:20 AM, Fri, Aug 21 2026";
  callSession.appointmentSelections.CONFIRM_APPOINTMENT = {
    createdAt: "2026-08-17T00:00:00.000Z",
    options: [
      option(501, "9:00 AM, Thu, Aug 20 2026"),
      option(502, "9:20 AM, Fri, Aug 21 2026")
    ]
  };

  promoteConfirmAppointmentPendingAction(callSession);

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT?.appointmentId, 502);
  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT?.status, "READY_TO_EXECUTE");
});

test("selects a confirmable appointment by date-only phrase", () => {
  const callSession = session();
  callSession.currentIntent = "CONFIRM_APPOINTMENT";
  callSession.collectedFields.selectedAppointmentDate = "August 24, 2026";
  callSession.appointmentSelections.CONFIRM_APPOINTMENT = {
    createdAt: "2026-08-17T00:00:00.000Z",
    options: [
      option(501, "9:00 AM on Thursday, August 21, 2026"),
      option(502, "10:00 AM on Monday, August 24, 2026")
    ]
  };

  promoteConfirmAppointmentPendingAction(callSession);

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT?.appointmentId, 502);
  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT?.status, "READY_TO_EXECUTE");
});

test("promotes selected appointment after lookup creates fresh options for the same confirm turn", () => {
  const callSession = session();
  callSession.currentIntent = "CONFIRM_APPOINTMENT";
  callSession.collectedFields.selectedAppointmentDate = "August 26, 2026";

  syncConfirmAppointmentFromLookup(callSession, "GET_NEXT_APPOINTMENT", {
    name: "GET_NEXT_APPOINTMENT",
    ok: true,
    data: {
      upcomingAppointments: [
        appointment(501, "10:00 AM on Wednesday, August 26, 2026"),
        appointment(502, "8:20 AM on Thursday, August 27, 2026")
      ]
    }
  }, "CONFIRM_APPOINTMENT");

  promoteConfirmAppointmentPendingAction(callSession);

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT?.appointmentId, 501);
  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT?.status, "READY_TO_EXECUTE");
});

test("does not create pending confirmation for non-confirm intent names containing confirm text", () => {
  const callSession = session();

  syncConfirmAppointmentFromLookup(callSession, "GET_NEXT_APPOINTMENT", {
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

  promoteConfirmAppointmentPendingAction(callSession);

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT.status, "READY_TO_EXECUTE");
});

test("does not promote pending confirmation from tool arguments alone", () => {
  const callSession = session();
  callSession.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId: 501,
    status: "AWAITING_CALLER_CONFIRMATION",
    createdAt: "2026-08-17T00:00:00.000Z"
  };

  promoteConfirmAppointmentPendingAction(callSession, {
    name: "CONFIRM_APPOINTMENT",
    arguments: {
      appointmentId: 501,
      callerConfirmedSelectedAppointment: true
    }
  });

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT.status, "AWAITING_CALLER_CONFIRMATION");
});

test("consumes pending confirmation after successful confirmation", () => {
  const callSession = session();
  callSession.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId: 501,
    status: "READY_TO_EXECUTE",
    createdAt: "2026-08-17T00:00:00.000Z"
  };
  callSession.collectedFields.callerConfirmedSelectedAppointment = true;

  consumeConfirmAppointmentPendingAction(callSession, "CONFIRM_APPOINTMENT", {
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

  const prepared = prepareConfirmAppointmentTool(callSession, {
    name: "CONFIRM_APPOINTMENT",
    arguments: {
      appointmentId: 501
    }
  });

  assert.equal(prepared.arguments.callerConfirmedSelectedAppointment, true);
});

test("adds pending appointment id when the model selected by date", () => {
  const callSession = session();
  callSession.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId: 502,
    status: "READY_TO_EXECUTE",
    createdAt: "2026-08-17T00:00:00.000Z"
  };

  const prepared = prepareConfirmAppointmentTool(callSession, {
    name: "CONFIRM_APPOINTMENT",
    arguments: {}
  });

  assert.equal(prepared.arguments.appointmentId, 502);
  assert.equal(prepared.arguments.callerConfirmedSelectedAppointment, true);
});

test("hydrates confirmation options from the last read-only lookup when caller switches intent", () => {
  const callSession = session();
  callSession.currentIntent = "CONFIRM_APPOINTMENT";
  callSession.lastToolResults.GET_NEXT_APPOINTMENT = {
    name: "GET_NEXT_APPOINTMENT",
    ok: true,
    data: {
      upcomingAppointments: [
        appointment(501, "9:00 AM, Thu, Aug 20 2026"),
        appointment(502, "9:20 AM, Fri, Aug 21 2026")
      ]
    }
  };

  hydrateConfirmAppointmentSelections(callSession);

  assert.equal(callSession.pendingActions.CONFIRM_APPOINTMENT, undefined);
  assert.deepEqual(
    callSession.appointmentSelections.CONFIRM_APPOINTMENT?.options.map((item) => item.appointmentId),
    [501, 502]
  );
});

function session(): CallSession {
  return {
    callSid: "CA-test",
    officeCode: "OFC001",
    startedAt: "2026-08-17T00:00:00.000Z",
    lastActivityAt: "2026-08-17T00:00:00.000Z",
    transcript: [],
    collectedFields: {},
    lastToolResults: {},
    pendingActions: {},
    appointmentSelections: {}
  };
}

function appointment(appointmentId: number, appointmentDate: string): Record<string, unknown> {
  return {
    appointmentId,
    appointmentDate,
    doctorName: "Dr. David Johnson",
    alreadyConfirmed: false
  };
}

function option(appointmentId: number, appointmentDate: string) {
  return {
    ...appointment(appointmentId, appointmentDate),
    source: appointment(appointmentId, appointmentDate)
  };
}
