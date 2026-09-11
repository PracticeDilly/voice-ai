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
  assert.match(new BookAppointmentToolAdapter().validateTool(callSession, prepared) ?? "", /office context only/);
  assert.equal(prepared.arguments.datePreference, "09/04/2026");
  assert.equal(prepared.arguments.timePreference, "morning");
  assert.equal(prepared.arguments.fromNumber, "+15551234567");
});

test("does not preserve a model placeholder as the patient phone", () => {
  const callSession = session();
  callSession.fromNumber = "+15551234567";

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      patientPhone: "fromNumber"
    }
  });

  assert.equal(prepared.arguments.patientPhone, undefined);
  assert.equal(prepared.arguments.fromNumber, "+15551234567");
});

test("expands a requested date into the full seven-day availability window", () => {
  const callSession = session();
  callSession.officeContext = {
    officeCode: "OFC001",
    timezone: "America/Los_Angeles"
  };

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      datePreference: "09/04/2026"
    }
  });

  assert.equal(prepared.arguments.fromDate, "09/04/2026");
  assert.equal(prepared.arguments.toDate, "09/11/2026");
});

test("preserves the model-provided availability range", () => {
  const callSession = session();
  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      fromDate: "09/04/2026",
      toDate: "09/11/2026"
    }
  });

  assert.equal(prepared.arguments.fromDate, "09/04/2026");
  assert.equal(prepared.arguments.toDate, "09/11/2026");
});

test("keeps initial provider name when it matches office context", () => {
  const callSession = session();
  callSession.officeContext = {
    officeCode: "OFC001",
    timezone: "America/Los_Angeles",
    providers: [
      { providerName: "Dr. Shah" }
    ]
  };

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      providerName: "Dr. Shah"
    }
  });

  assert.equal(prepared.arguments.providerName, "Dr. Shah");
});

test("uses single office context provider for initial booking request", () => {
  const callSession = session();
  callSession.officeContext = {
    officeCode: "OFC001",
    timezone: "America/Los_Angeles",
    providers: [
      { displayProvider: "Dr. Shah" }
    ]
  };

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      bookingReason: "tooth pain",
      datePreference: "09/04/2026"
    }
  });

  assert.equal(prepared.arguments.providerName, "Dr. Shah");
});

test("retains an invalid provider for validation instead of silently substituting a default", () => {
  const callSession = session();
  callSession.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "NEEDS_PROVIDER_SELECTION"
  };

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      providerName: "Dr. Shah"
    }
  });

  assert.equal(prepared.arguments.providerName, "Dr. Shah");
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

test("rejects unsupported booking date expressions before the backend call", () => {
  const callSession = session();
  const adapter = new BookAppointmentToolAdapter();
  const prepared = adapter.prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: { datePreference: "next week" }
  });

  assert.match(adapter.validateTool(callSession, prepared) ?? "", /specific valid appointment date/);
});

test("rejects impossible calendar dates before the backend call", () => {
  const callSession = session();
  const adapter = new BookAppointmentToolAdapter();
  const prepared = adapter.prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: { datePreference: "02/31/2026" }
  });

  assert.match(adapter.validateTool(callSession, prepared) ?? "", /specific valid appointment date/);
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

test("rejects a selected slot that was not returned by availability", () => {
  const callSession = session();
  callSession.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "REQUIRES_CONFIRMATION",
    context: {
      slotDate: "09/04/2026",
      slotTime: "09:00 AM",
      slots: [{ slotDate: "09/04/2026", slotTime: "10:00 AM" }]
    }
  };

  const error = new BookAppointmentToolAdapter().validateTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: { callerConfirmedBooking: true }
  });

  assert.match(error ?? "", /slot returned by the availability search/);
});

test("does not convert a conversational time preference into a slot selection", () => {
  const callSession = session();
  callSession.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "SELECT_SLOT",
    context: {
      slots: [
        { slotDate: "09/08/2026", slotTime: "09:10 AM" },
        { slotDate: "09/08/2026", slotTime: "10:10 AM" }
      ]
    }
  };

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      timePreference: "10:10AM"
    }
  });

  assert.equal(prepared.arguments.slotDate, undefined);
  assert.equal(prepared.arguments.slotTime, undefined);
  assert.equal(prepared.arguments.timePreference, "10:10AM");
});

test("validates returning-patient type and provider on active booking turns", () => {
  const callSession = session();
  callSession.officeContext = {
    officeCode: "OFC001", timezone: "America/Los_Angeles",
    providers: [{ name: "Dr. Shah" }],
    appointmentTypes: {
      RETURNING_PATIENT: [{ appointmentTypeId: 12, type: "Cleaning", duration: 60 }],
      NEW_PATIENT: [{ appointmentTypeId: 13, type: "Initial exam", duration: 90 }]
    }
  };
  callSession.workflowState = { contractVersion: 1, workflow: "BOOK_APPOINTMENT", state: "SELECT_SLOT" };
  callSession.collectedFields = { appointmentTypeId: 12, bookingReason: "Cleaning and sensitivity" };
  const adapter = new BookAppointmentToolAdapter();
  const prepared = adapter.prepareTool(callSession, {
    name: "BOOK_APPOINTMENT", arguments: { patientId: 999, pmsProviderId: 999 }
  });
  assert.equal(prepared.arguments.appointmentTypeId, 12);
  assert.equal(prepared.arguments.bookingReason, "Cleaning and sensitivity");
  assert.equal(prepared.arguments.providerName, "Dr. Shah");
  assert.equal(prepared.arguments.patientId, undefined);
  assert.equal(prepared.arguments.pmsProviderId, undefined);
  assert.equal(adapter.validateTool(callSession, prepared), undefined);
  for (const appointmentTypeId of [13, 99, "12"]) {
    assert.match(adapter.validateTool(callSession, {
      ...prepared, arguments: { ...prepared.arguments, appointmentTypeId }
    }) ?? "", /RETURNING_PATIENT/);
  }
  assert.match(adapter.validateTool(callSession, {
    ...prepared, arguments: { ...prepared.arguments, providerName: "Widget-only provider" }
  }) ?? "", /office context only/);
});

test("validates new-patient appointment types from the new-patient catalog", () => {
  const callSession = session();
  callSession.officeContext = {
    officeCode: "OFC001", timezone: "America/Los_Angeles",
    appointmentTypes: {
      RETURNING_PATIENT: [{ appointmentTypeId: 12, type: "Cleaning", duration: 60 }],
      NEW_PATIENT: [{ appointmentTypeId: 13, type: "Initial exam", duration: 90 }]
    }
  };
  callSession.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "SELECT_SLOT",
    context: { patientType: "NEW_PATIENT" }
  };

  const adapter = new BookAppointmentToolAdapter();
  const prepared = adapter.prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: { appointmentTypeId: 13 }
  });

  assert.equal(adapter.validateTool(callSession, prepared), undefined);
  assert.match(adapter.validateTool(callSession, {
    ...prepared, arguments: { ...prepared.arguments, appointmentTypeId: 12 }
  }) ?? "", /NEW_PATIENT/);
});

test("uses the persisted new-patient candidate before backend state changes", () => {
  const callSession = session();
  callSession.officeContext = {
    officeCode: "OFC001", timezone: "America/Los_Angeles",
    appointmentTypes: {
      RETURNING_PATIENT: [{ appointmentTypeId: 12, type: "Cleaning", duration: 60 }],
      NEW_PATIENT: [{ appointmentTypeId: 13, type: "Initial exam", duration: 90 }]
    }
  };
  callSession.workflowState = {
    contractVersion: 1,
    workflow: "PATIENT_VERIFICATION",
    state: "FAILED",
    failureReason: "FIRST_NAME_NO_MATCH",
    context: { patientVerified: false, canDisclosePatientData: false }
  };
  callSession.newPatientBookingCandidate = true;

  const adapter = new BookAppointmentToolAdapter();
  assert.equal(adapter.validateTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: { appointmentTypeId: 13 }
  }), undefined);
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
