import assert from "node:assert/strict";
import test from "node:test";
import { CallSession } from "../../src/calls/callSession.js";
import { BookAppointmentToolAdapter } from "../../src/workflows/bookAppointment/bookAppointmentToolAdapter.js";
import { correctBookingWeekdayMentions } from "../../src/workflows/bookAppointment/bookingDatePreference.js";
import {
  allNewPatientDataConfirmed,
  constrainNewPatientDataUpdates,
  newPatientConfirmationFields,
  pendingNewPatientConfirmation,
  markNewPatientConfirmationPrompt,
  newPatientConfirmationQuestion,
  synchronizeNewPatientDataConfirmation
} from "../../src/workflows/shared/newPatientDataConfirmation.js";

test("prepares booking request with caller number and collected conversational fields", () => {
  const callSession = session();
  callSession.fromNumber = "+15551234567";
  callSession.collectedFields.firstName = "Priya";
  callSession.collectedFields.dob = "1990-04-15";
  callSession.collectedFields.bookingReason = "tooth pain";
  callSession.collectedFields.gender = "Female";
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
  assert.equal(prepared.arguments.gender, "Female");
  assert.match(new BookAppointmentToolAdapter().validateTool(callSession, prepared) ?? "", /office context only/);
  assert.equal(prepared.arguments.datePreference, "09/04/2026");
  assert.equal(prepared.arguments.timePreference, "morning");
  assert.equal(prepared.arguments.fromNumber, "+15551234567");
  assert.equal(prepared.arguments.patientPhone, "+15551234567");
});

test("resolves a model phone placeholder to the actual caller number", () => {
  const callSession = session();
  callSession.fromNumber = "+15551234567";

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      patientPhone: "fromNumber"
    }
  });

  assert.equal(prepared.arguments.patientPhone, "+15551234567");
  assert.equal(prepared.arguments.fromNumber, "+15551234567");
});

test("keeps a requested date as an exact availability window", () => {
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
  assert.equal(prepared.arguments.toDate, "09/04/2026");
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

test("does not reuse a stale availability range when a new date is requested", () => {
  const callSession = session();
  callSession.collectedFields.fromDate = "09/15/2026";
  callSession.collectedFields.toDate = "09/22/2026";

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      datePreference: "09/16/2026"
    }
  });

  assert.equal(prepared.arguments.fromDate, "09/16/2026");
  assert.equal(prepared.arguments.toDate, "09/16/2026");
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

test("resolves next-week weekday to the next upcoming calendar date", () => {
  const callSession = session();
  callSession.startedAt = "2026-09-12T18:00:00.000Z";
  callSession.officeContext = {
    officeCode: "OFC001",
    timezone: "America/Los_Angeles"
  };

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: { datePreference: "Tuesday next week" }
  });

  assert.equal(prepared.arguments.datePreference, "09/15/2026");
  assert.equal(prepared.arguments.fromDate, "09/15/2026");
  assert.equal(prepared.arguments.toDate, "09/15/2026");
});

test("preserves a DOB held under the canonical collected-field name", () => {
  const callSession = session();
  callSession.collectedFields.dob = "11/26/2003";

  const prepared = new BookAppointmentToolAdapter().prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: { firstName: "Nancy" }
  });

  assert.equal(prepared.arguments.dob, "11/26/2003");
  assert.equal(prepared.arguments.dateOfBirth, undefined);
});

test("corrects a spoken weekday when the returned numeric date disagrees", () => {
  assert.equal(
    correctBookingWeekdayMentions("Wednesday, September 24th is available.", ["09/24/2026"]),
    "Thursday, September 24th is available."
  );
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

test("selects a returned slot before sending final booking approval", () => {
  const callSession = session();
  callSession.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "SELECT_SLOT",
    context: { slots: [{ slotDate: "10/02/2026", slotTime: "04:30 PM" }] }
  };
  const adapter = new BookAppointmentToolAdapter();
  const prepared = adapter.prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {
      slotDate: "10/02/2026",
      slotTime: "04:30 PM",
      callerConfirmedBooking: true
    }
  });

  assert.equal(prepared.arguments.callerConfirmedBooking, false);
  assert.equal(adapter.validateTool(callSession, prepared), undefined);
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

test("rejects a booking without an eligible appointment type before the backend call", () => {
  const callSession = session();
  callSession.officeContext = {
    officeCode: "OFC001",
    timezone: "America/Los_Angeles",
    appointmentTypes: {
      RETURNING_PATIENT: [{ appointmentTypeId: 12, type: "Cleaning", duration: 60 }]
    }
  };
  const adapter = new BookAppointmentToolAdapter();
  const prepared = adapter.prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: { firstName: "Nancy", dob: "04/01/2000", bookingReason: "Cleaning" }
  });

  assert.match(adapter.validateTool(callSession, prepared) ?? "", /requires a numeric RETURNING_PATIENT appointmentTypeId that exists/);
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
  callSession.collectedFields = {
    firstName: "Maddie",
    lastName: "Brown",
    dob: "11/11/1999",
    gender: "Female",
    patientEmail: "maddie@example.com",
    patientPhone: "9494846418"
  };
  callSession.newPatientDataConfirmation = {
    confirmed: {
      firstName: "Maddie",
      lastName: "Brown",
      dob: "11/11/1999",
      patientEmail: "maddie@example.com",
      patientPhone: "9494846418"
    }
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
  callSession.collectedFields = {
    firstName: "Maddie",
    lastName: "Brown",
    dob: "11/11/1999",
    gender: "Female",
    patientEmail: "maddie@example.com",
    patientPhone: "9494846418"
  };
  callSession.newPatientDataConfirmation = {
    confirmed: {
      firstName: "Maddie",
      lastName: "Brown",
      dob: "11/11/1999",
      patientEmail: "maddie@example.com",
      patientPhone: "9494846418"
    }
  };

  const adapter = new BookAppointmentToolAdapter();
  assert.equal(adapter.validateTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: { appointmentTypeId: 13 }
  }), undefined);
});

test("blocks PMS execution until complete new-patient data is confirmed", () => {
  const callSession = session();
  callSession.fromNumber = "+15551234567";
  callSession.newPatientBookingCandidate = true;
  callSession.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "NEEDS_NEW_PATIENT_DATA",
    context: { patientType: "NEW_PATIENT" }
  };
  callSession.collectedFields = {
    firstName: "Madi",
    lastName: "Brown",
    dob: "11/11/1999",
    gender: "Female",
    patientPhone: "9494846418",
    patientEmail: "madi.brown@example.com",
    appointmentTypeId: 13
  };
  callSession.officeContext = {
    officeCode: "OFC001",
    timezone: "America/Los_Angeles",
    appointmentTypes: {
      NEW_PATIENT: [{ appointmentTypeId: 13, type: "Initial exam", duration: 60 }]
    }
  };

  const adapter = new BookAppointmentToolAdapter();
  const prepared = adapter.prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: {}
  });
  assert.match(adapter.validateTool(callSession, prepared) ?? "", /confirmation of the patient's name, date of birth, email, and phone/);

  synchronizeNewPatientDataConfirmation(callSession, {
    confirmedFields: [...newPatientConfirmationFields]
  });
  assert.match(adapter.validateTool(callSession, prepared) ?? "", /confirmation of the patient's name/);

  for (const field of newPatientConfirmationFields) {
    markNewPatientConfirmationPrompt(callSession, field);
    if (field === "firstName" || field === "lastName") {
      synchronizeNewPatientDataConfirmation(callSession, { collectedFields: {} }, "M A D I");
    }
    synchronizeNewPatientDataConfirmation(callSession, { collectedFields: {} }, "Yes, that's correct.");
  }
  assert.equal(adapter.validateTool(callSession, prepared), undefined);
});

test("confirms new-patient fields once and reopens only a corrected field", () => {
  const callSession = session();
  callSession.fromNumber = "+15551234567";
  callSession.newPatientBookingCandidate = true;
  callSession.collectedFields = {
    firstName: "Madi",
    lastName: "Brown",
    dob: "11/11/1999",
    gender: "Female",
    patientPhone: "9494846418",
    patientEmail: "madi.brown@example.com"
  };

  synchronizeNewPatientDataConfirmation(callSession, { collectedFields: callSession.collectedFields });
  assert.equal(pendingNewPatientConfirmation(callSession), "firstName");

  markNewPatientConfirmationPrompt(callSession, "firstName");
  synchronizeNewPatientDataConfirmation(callSession, { collectedFields: { firstName: "Madi" } }, "M A D I");
  assert.equal(callSession.newPatientDataConfirmation?.prompted?.kind, "CONFIRM");
  synchronizeNewPatientDataConfirmation(callSession, { collectedFields: {} }, "Yes, that's correct.");
  assert.equal(pendingNewPatientConfirmation(callSession), "lastName");

  synchronizeNewPatientDataConfirmation(callSession, {
    confirmedFields: newPatientConfirmationFields.filter((field) => field !== "firstName")
  });
  for (const field of newPatientConfirmationFields.filter((field) => field !== "firstName")) {
    markNewPatientConfirmationPrompt(callSession, field);
    if (field === "lastName") {
      synchronizeNewPatientDataConfirmation(callSession, { collectedFields: {} }, "B R O W N");
    }
    synchronizeNewPatientDataConfirmation(callSession, { collectedFields: {} }, "Yes, that's correct.");
  }
  assert.equal(allNewPatientDataConfirmed(callSession), true);

  synchronizeNewPatientDataConfirmation(callSession, {
    collectedFields: { patientEmail: "madi.brown+new@example.com" }
  });
  assert.equal(pendingNewPatientConfirmation(callSession), "patientEmail");
  assert.equal(callSession.newPatientDataConfirmation?.confirmed.firstName, "Madi");
});

test("merges only the active new-patient field", () => {
  const callSession = session();
  callSession.newPatientBookingCandidate = true;
  callSession.collectedFields = {
    firstName: "Stacy",
    lastName: "Jones",
    patientEmail: "old@example.com"
  };
  callSession.newPatientDataConfirmation = {
    confirmed: {
      firstName: "Stacy",
      lastName: "Jones"
    },
    prompted: {
      field: "patientEmail",
      value: "old@example.com",
      kind: "CONFIRM"
    }
  };

  const result = {
    updatedFields: ["patientEmail", "lastName"],
    collectedFields: {
      lastName: "K A U R",
      patientEmail: "sukhjotkaur2411@gmail.com"
    }
  };
  constrainNewPatientDataUpdates(callSession, result);
  callSession.collectedFields = {
    ...callSession.collectedFields,
    ...result.collectedFields
  };
  synchronizeNewPatientDataConfirmation(
    callSession,
    result,
    "I am telling you my email, which is sukhjotkaur2411@gmail.com."
  );

  assert.deepEqual(result.updatedFields, ["patientEmail"]);
  assert.equal(result.collectedFields.lastName, undefined);
  assert.equal(callSession.collectedFields.lastName, "Jones");
  assert.equal(callSession.newPatientDataConfirmation?.confirmed.lastName, "Jones");
});

test("spells the captured email back for one confirmation", () => {
  const callSession = session();
  callSession.newPatientBookingCandidate = true;
  callSession.collectedFields.patientEmail = "madi.brown+new@example.com";

  markNewPatientConfirmationPrompt(callSession, "patientEmail");

  assert.equal(callSession.newPatientDataConfirmation?.prompted?.kind, "CONFIRM");
  assert.match(
    newPatientConfirmationQuestion(callSession, "patientEmail"),
    /m a d i dot b r o w n plus n e w at e x a m p l e dot c o m/i
  );
  assert.match(newPatientConfirmationQuestion(callSession, "patientEmail"), /is that correct/i);
});

test("does not accept model confirmation without a matching Node read-back prompt", () => {
  const callSession = session();
  callSession.newPatientBookingCandidate = true;
  callSession.collectedFields = {
    firstName: "Maddie",
    lastName: "Brown",
    dob: "11/11/1999",
    gender: "Female",
    patientEmail: "maddie@example.com",
    patientPhone: "9494846418"
  };

  synchronizeNewPatientDataConfirmation(callSession, {
    confirmedFields: ["firstName"]
  });

  assert.equal(callSession.newPatientDataConfirmation?.confirmed.firstName, undefined);
  assert.equal(pendingNewPatientConfirmation(callSession), "firstName");
});

test("reads a corrected spelling back once instead of asking for the spelling again", () => {
  const callSession = session();
  callSession.newPatientBookingCandidate = true;
  callSession.collectedFields = {
    firstName: "Madi",
    lastName: "Brown",
    dob: "11/11/1999",
    gender: "Female",
    patientEmail: "maddie@example.com",
    patientPhone: "9494846418"
  };
  markNewPatientConfirmationPrompt(callSession, "firstName");

  callSession.collectedFields.firstName = "Maddie";
  synchronizeNewPatientDataConfirmation(callSession, {
    collectedFields: { firstName: "Maddie" },
    updatedFields: ["firstName"]
  }, "M A D D I E");

  assert.equal(callSession.newPatientDataConfirmation?.prompted?.kind, "CONFIRM");
  assert.match(newPatientConfirmationQuestion(callSession, "firstName"), /spelled M a d d i e/i);
  assert.equal(callSession.newPatientDataConfirmation?.confirmed.firstName, undefined);
});

test("confirms caller ID by last four digits", () => {
  const callSession = session();
  callSession.newPatientBookingCandidate = true;
  callSession.fromNumber = "+15551234567";
  callSession.collectedFields.patientPhone = "+15551234567";
  markNewPatientConfirmationPrompt(callSession, "patientPhone");

  assert.match(newPatientConfirmationQuestion(callSession, "patientPhone"), /ending in 4 5 6 7/i);
  assert.doesNotMatch(newPatientConfirmationQuestion(callSession, "patientPhone"), /\+15551234567/);
});

test("does not add a separate gender confirmation or redundant summary", () => {
  const callSession = session();
  callSession.newPatientBookingCandidate = true;
  callSession.collectedFields = {
    firstName: "Maddie",
    lastName: "Brown",
    dob: "11/11/1999",
    gender: "Female",
    patientEmail: "maddie@example.com",
    patientPhone: "9494846418"
  };

  for (const field of newPatientConfirmationFields) {
    markNewPatientConfirmationPrompt(callSession, field);
    if (field === "firstName" || field === "lastName") {
      synchronizeNewPatientDataConfirmation(callSession, { collectedFields: {} }, "spelled name");
    }
    synchronizeNewPatientDataConfirmation(callSession, { collectedFields: {} }, "Yes");
  }

  assert.equal(pendingNewPatientConfirmation(callSession), undefined);
  assert.equal(allNewPatientDataConfirmed(callSession), true);
  assert.equal(callSession.newPatientDataConfirmation?.summaryConfirmed, undefined);
});

test("offers bounded recovery after two failed field confirmations", () => {
  const callSession = session();
  callSession.newPatientBookingCandidate = true;
  callSession.collectedFields = {
    firstName: "Maddie",
    lastName: "Brown",
    dob: "11/11/1999",
    gender: "Female",
    patientEmail: "maddie@example.com",
    patientPhone: "9494846418"
  };

  markNewPatientConfirmationPrompt(callSession, "dob");
  synchronizeNewPatientDataConfirmation(callSession, { collectedFields: {} }, "No");
  markNewPatientConfirmationPrompt(callSession, "dob");
  synchronizeNewPatientDataConfirmation(callSession, { collectedFields: {} }, "No");

  assert.match(newPatientConfirmationQuestion(callSession, "dob"), /say staff/i);
  assert.match(newPatientConfirmationQuestion(callSession, "dob"), /one more time/i);
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
