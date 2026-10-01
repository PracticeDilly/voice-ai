import assert from "node:assert/strict";
import test from "node:test";
import { CallSession } from "../../src/calls/callSession.js";
import { BookAppointmentToolAdapter } from "../../src/workflows/bookAppointment/bookAppointmentToolAdapter.js";
import { correctBookingRelativeDateMentions, correctBookingWeekdayMentions, isBookingDateRangeValid } from "../../src/workflows/bookAppointment/bookingDatePreference.js";

test("corrects impossible or off-by-one spoken relative dates in the office timezone", () => {
  const now = "2026-09-30T11:29:00.000Z";
  assert.equal(
    correctBookingRelativeDateMentions("Would you prefer tomorrow, September 31, 2026?", "America/Los_Angeles", now),
    "Would you prefer tomorrow, October 1, 2026?"
  );
  assert.equal(
    correctBookingRelativeDateMentions("Today, October 1, 2026 also works.", "America/Los_Angeles", now),
    "Today, September 30, 2026 also works."
  );
});
import {
  allNewPatientDataConfirmed,
  constrainNewPatientDataUpdates,
  readBackNewPatientName,
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

test("searches a bounded range when the caller accepts either upcoming day", () => {
  const callSession = session();
  callSession.startedAt = "2026-09-30T11:29:00.000Z";
  callSession.officeContext = { officeCode: "OFC001", timezone: "America/Los_Angeles" };
  const adapter = new BookAppointmentToolAdapter();
  const prepared = adapter.prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: { datePreference: "tomorrow or day after tomorrow" }
  });
  assert.equal(prepared.arguments.datePreference, "10/01/2026");
  assert.equal(prepared.arguments.fromDate, "10/01/2026");
  assert.equal(prepared.arguments.toDate, "10/02/2026");
  assert.equal(isBookingDateRangeValid(prepared.arguments.fromDate, prepared.arguments.toDate), true);
});

test("searches the next week when the caller says any day is fine", () => {
  const callSession = session();
  callSession.startedAt = "2026-09-30T11:29:00.000Z";
  callSession.officeContext = { officeCode: "OFC001", timezone: "America/Los_Angeles" };
  const adapter = new BookAppointmentToolAdapter();
  const prepared = adapter.prepareTool(callSession, {
    name: "BOOK_APPOINTMENT",
    arguments: { datePreference: "any day" }
  });
  assert.equal(prepared.arguments.fromDate, "09/30/2026");
  assert.equal(prepared.arguments.toDate, "10/07/2026");
  assert.equal(isBookingDateRangeValid(prepared.arguments.fromDate, prepared.arguments.toDate), true);
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

  markNewPatientConfirmationPrompt(callSession, "firstName");
  synchronizeNewPatientDataConfirmation(callSession, { confirmedFields: ["firstName"] }, "Yes, that's right.");
  assert.match(adapter.validateTool(callSession, prepared) ?? "", /confirmation of the patient's email and phone/);

  synchronizeNewPatientDataConfirmation(callSession, {
    confirmedFields: [...newPatientConfirmationFields]
  });
  assert.match(adapter.validateTool(callSession, prepared) ?? "", /confirmation of the patient's email and phone/);

  for (const field of ["patientEmail", "patientPhone"] as const) {
    markNewPatientConfirmationPrompt(callSession, field);
    synchronizeNewPatientDataConfirmation(callSession, { confirmedFields: [field] }, "Yes, that's correct.");
  }
  assert.equal(adapter.validateTool(callSession, prepared), undefined);
});

test("confirms contact fields once and reopens only a corrected email", () => {
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

  markNewPatientConfirmationPrompt(callSession, "firstName");
  synchronizeNewPatientDataConfirmation(callSession, { confirmedFields: ["firstName"] }, "Yes, that's right.");
  synchronizeNewPatientDataConfirmation(callSession, { collectedFields: callSession.collectedFields });
  assert.equal(pendingNewPatientConfirmation(callSession), "patientEmail");

  for (const field of ["patientEmail", "patientPhone"] as const) {
    markNewPatientConfirmationPrompt(callSession, field);
    synchronizeNewPatientDataConfirmation(callSession, { confirmedFields: [field] }, "Yes, that's correct.");
  }
  assert.equal(allNewPatientDataConfirmed(callSession), true);

  callSession.collectedFields.patientEmail = "madi.brown+new@example.com";
  synchronizeNewPatientDataConfirmation(callSession, { collectedFields: { patientEmail: "madi.brown+new@example.com" } });
  assert.equal(pendingNewPatientConfirmation(callSession), "patientEmail");
  assert.equal(callSession.newPatientDataConfirmation?.confirmed.patientPhone, "9494846418");
});

test("spells a new patient's name back once and confirms the combined name", () => {
  const callSession = session();
  callSession.newPatientBookingCandidate = true;
  callSession.collectedFields = { firstName: "Erica", lastName: "Jones", dob: "10/01/2001", gender: "Female", patientPhone: "+15551234567" };
  assert.equal(pendingNewPatientConfirmation(callSession), "firstName");
  markNewPatientConfirmationPrompt(callSession, "firstName");
  assert.match(newPatientConfirmationQuestion(callSession, "firstName"), /E R I C A, Erica, and last name J O N E S, Jones/i);
  assert.match(newPatientConfirmationQuestion(callSession, "firstName"), /is that correct/i);

  synchronizeNewPatientDataConfirmation(callSession, { confirmedFields: ["firstName"] }, "Yes, that's right.");
  assert.equal(pendingNewPatientConfirmation(callSession), undefined);
  assert.equal(readBackNewPatientName(callSession, "What is the date of birth?"), "What is the date of birth?");
});

test("accepts a corrected name directly without another confirmation", () => {
  const callSession = session();
  callSession.newPatientBookingCandidate = true;
  callSession.collectedFields = { firstName: "Erica", lastName: "Jones" };
  markNewPatientConfirmationPrompt(callSession, "firstName");

  const result = {
    callerAction: { speechAct: "CORRECTION" as const },
    updatedFields: ["firstName"],
    collectedFields: { firstName: "Hannah" }
  };
  constrainNewPatientDataUpdates(callSession, result);
  callSession.collectedFields = { ...callSession.collectedFields, ...result.collectedFields };
  synchronizeNewPatientDataConfirmation(callSession, result, "Actually, it's Hannah.");

  assert.equal(callSession.collectedFields.firstName, "Hannah");
  assert.equal(callSession.newPatientDataConfirmation?.confirmed.firstName, "Hannah");
  assert.equal(pendingNewPatientConfirmation(callSession), undefined);
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

test("does not require a separate name or DOB confirmation", () => {
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

  markNewPatientConfirmationPrompt(callSession, "firstName");
  synchronizeNewPatientDataConfirmation(callSession, { confirmedFields: ["firstName"] }, "Yes, that's right.");
  assert.equal(callSession.newPatientDataConfirmation?.confirmed.firstName, "Maddie");
  assert.equal(callSession.newPatientDataConfirmation?.confirmed.lastName, "Brown");
  assert.equal(pendingNewPatientConfirmation(callSession), "patientEmail");
});

test("accepts a full name together and preserves unrelated name fields during email correction", () => {
  const callSession = session();
  callSession.newPatientBookingCandidate = true;
  callSession.collectedFields = { firstName: "Erica", lastName: "Jones", patientEmail: "old@example.com" };
  callSession.newPatientDataConfirmation = {
    confirmed: { firstName: "Erica", lastName: "Jones" },
    prompted: { field: "patientEmail", value: "old@example.com", kind: "CONFIRM" }
  };
  const result = {
    updatedFields: ["patientEmail", "lastName"],
    collectedFields: { patientEmail: "erica@practicedilly.com", lastName: "Erica@practicedilly.com" }
  };
  constrainNewPatientDataUpdates(callSession, result);
  assert.equal(result.collectedFields.lastName, undefined);
  assert.equal(result.collectedFields.patientEmail, "erica@practicedilly.com");
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

test("does not add separate name, DOB, or gender confirmation steps", () => {
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

  assert.equal(pendingNewPatientConfirmation(callSession), "firstName");
  assert.equal(allNewPatientDataConfirmed(callSession), false);
  markNewPatientConfirmationPrompt(callSession, "firstName");
  synchronizeNewPatientDataConfirmation(callSession, { confirmedFields: ["firstName"] }, "Yes, that's right.");
  assert.equal(pendingNewPatientConfirmation(callSession), "patientEmail");
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
