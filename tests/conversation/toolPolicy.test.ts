import assert from "node:assert/strict";
import test from "node:test";
import { CallSession } from "../../src/calls/callSession.js";
import { applyWorkflowToolResultPolicies, applyWorkflowTurnPolicies, prepareWorkflowTool } from "../../src/workflows/shared/workflowRegistry.js";

test("forces patient verification before a next-appointment lookup when the office enables it", () => {
  const call = session({
    collectedFields: {
      firstName: "Madi",
      dob: "11/11/1999"
    }
  });
  call.officeContext = {
    officeCode: "OFC001",
    timezone: "America/Los_Angeles",
    allowedActions: ["VERIFY_PATIENT", "GET_NEXT_APPOINTMENT"]
  };

  const decision = applyWorkflowTurnPolicies(call, {
    intent: "NEXT_APPOINTMENT",
    toolRequest: {
      name: "GET_NEXT_APPOINTMENT",
      arguments: {}
    }
  });

  assert.equal(decision?.overrideResult?.toolRequest?.name, "VERIFY_PATIENT");
  assert.deepEqual(decision?.overrideResult?.toolRequest?.arguments, {
    firstName: "Madi",
    dob: "11/11/1999"
  });
  assert.equal(call.pendingPatientWorkflow?.name, "GET_NEXT_APPOINTMENT");

  call.workflowState = {
    contractVersion: 1,
    workflow: "PATIENT_VERIFICATION",
    state: "COMPLETED",
    context: {
      patientVerified: true,
      canDisclosePatientData: true
    }
  };
  call.verifiedIdentityFingerprint = JSON.stringify({
    fromNumber: "",
    firstName: "Madi",
    dob: "11/11/1999"
  });
  const afterVerification = applyWorkflowToolResultPolicies(call, "VERIFY_PATIENT", { ok: true });
  assert.equal(afterVerification?.overrideResult?.toolRequest?.name, "GET_NEXT_APPOINTMENT");
  assert.equal(call.pendingPatientWorkflow, undefined);
});

test("replays the active next-appointment lookup after direct patient verification", () => {
  const call = session({
    currentIntent: "NEXT_APPOINTMENT",
    collectedFields: {
      firstName: "Mary",
      dob: "11/11/1999"
    }
  });
  call.officeContext = {
    officeCode: "OFC001",
    timezone: "America/Los_Angeles",
    allowedActions: ["VERIFY_PATIENT", "GET_NEXT_APPOINTMENT"]
  };

  const verificationTurn = applyWorkflowTurnPolicies(call, {
    intent: "NEXT_APPOINTMENT",
    toolRequest: {
      name: "VERIFY_PATIENT",
      arguments: {
        firstName: "Mary",
        dob: "11/11/1999"
      }
    }
  });

  assert.equal(verificationTurn, undefined);
  assert.equal(call.pendingPatientWorkflow?.name, "GET_NEXT_APPOINTMENT");

  call.workflowState = {
    contractVersion: 1,
    workflow: "PATIENT_VERIFICATION",
    state: "COMPLETED",
    context: {
      patientVerified: true,
      canDisclosePatientData: true
    }
  };
  call.verifiedIdentityFingerprint = JSON.stringify({
    fromNumber: "",
    firstName: "Mary",
    dob: "11/11/1999"
  });

  const replay = applyWorkflowToolResultPolicies(call, "VERIFY_PATIENT", { ok: true });
  assert.equal(replay?.overrideResult?.toolRequest?.name, "GET_NEXT_APPOINTMENT");
  assert.deepEqual(replay?.overrideResult?.toolRequest?.arguments, {
    firstName: "Mary",
    dob: "11/11/1999"
  });
});

test("continues booking after verification identifies a new-patient candidate", () => {
  const call = session({
    currentIntent: "BOOK_APPOINTMENT",
    collectedFields: {
      firstName: "Madi",
      bookingReason: "dental cleaning"
    }
  });
  call.pendingPatientWorkflow = {
    name: "BOOK_APPOINTMENT",
    arguments: {
      firstName: "Madi",
      bookingReason: "dental cleaning"
    },
    createdAt: "2026-09-10T00:00:00.000Z"
  };
  call.workflowState = {
    contractVersion: 1,
    workflow: "PATIENT_VERIFICATION",
    state: "NEW_PATIENT_CANDIDATE",
    context: {
      patientVerified: false,
      canDisclosePatientData: false,
      patientType: "NEW_PATIENT"
    }
  };

  const replay = applyWorkflowToolResultPolicies(call, "VERIFY_PATIENT", { ok: true });

  assert.equal(replay?.overrideResult?.toolRequest?.name, "BOOK_APPOINTMENT");
  assert.equal(call.newPatientBookingCandidate, true);
  assert.equal(call.pendingPatientWorkflow, undefined);
  assert.equal(replay?.overrideResult?.toolRequest?.arguments.continueAsNewPatient, true);
});

test("requires explicit consent before continuing as a new patient", () => {
  const call = session({
    currentIntent: "BOOK_APPOINTMENT",
    collectedFields: {
      firstName: "Mary",
      dob: "11/11/1999",
      bookingReason: "dental cleaning"
    },
    workflowState: {
      contractVersion: 1,
      workflow: "PATIENT_VERIFICATION",
      state: "NEEDS_NEW_PATIENT_CONFIRMATION",
      allowedActions: ["BOOK_APPOINTMENT", "TRANSFER_TO_STAFF"],
      failureReason: "NO_EXISTING_PATIENT_RECORD",
      context: {
        patientVerified: false,
        canDisclosePatientData: false
      }
    }
  });

  const decision = applyWorkflowTurnPolicies(call, {
    intent: "BOOK_APPOINTMENT",
    callerAction: {
      speechAct: "AUTHORIZATION",
      workflowIntent: "BOOK_APPOINTMENT",
      authorization: {
        stateChangingAction: "CONTINUE_AS_NEW_PATIENT",
        isExplicit: true
      }
    }
  });

  assert.equal(decision?.overrideResult?.toolRequest?.name, "VERIFY_PATIENT");
  assert.equal(decision?.overrideResult?.toolRequest?.arguments.continueAsNewPatient, true);
});

test("does not transfer after an unsuccessful verification without caller authorization", () => {
  const decision = applyWorkflowTurnPolicies(session({
    currentIntent: "BOOK_APPOINTMENT",
    workflowState: {
      contractVersion: 1,
      workflow: "PATIENT_VERIFICATION",
      state: "NEEDS_NEW_PATIENT_CONFIRMATION",
      allowedActions: ["BOOK_APPOINTMENT", "TRANSFER_TO_STAFF"],
      failureReason: "NO_EXISTING_PATIENT_RECORD",
      context: {
        patientVerified: false,
        canDisclosePatientData: false
      }
    }
  }), {
    intent: "TRANSFER_TO_STAFF",
    toolRequest: { name: "TRANSFER_TO_STAFF", arguments: {} }
  });

  assert.equal(decision?.repromptContext?.type, "NEW_PATIENT_CONFIRMATION");
  assert.equal(decision?.overrideResult, undefined);
});

test("retries verification with the corrected first-name spelling", () => {
  const call = session({
    currentIntent: "BOOK_APPOINTMENT",
    pendingIdentityStatus: "NEEDS_NAME_SPELLING",
    workflowState: {
      contractVersion: 1,
      workflow: "PATIENT_VERIFICATION",
      state: "FAILED",
      allowedActions: ["VERIFY_PATIENT", "TRANSFER_TO_STAFF"],
      failureReason: "FIRST_NAME_NO_MATCH",
      context: {
        patientVerified: false,
        canDisclosePatientData: false
      }
    },
    collectedFields: { dob: "11/11/1999" }
  });

  const decision = applyWorkflowTurnPolicies(call, {
    intent: "BOOK_APPOINTMENT",
    collectedFields: { firstName: "Maddie" }
  });

  assert.equal(decision?.overrideResult?.toolRequest?.name, "VERIFY_PATIENT");
  assert.equal(decision?.overrideResult?.toolRequest?.arguments.firstName, "Maddie");
});

test("prioritizes a corrected first name over an inferred transfer", () => {
  const call = session({
    currentIntent: "NEXT_APPOINTMENT",
    pendingIdentityStatus: "NEEDS_NAME_SPELLING",
    workflowState: {
      contractVersion: 1,
      workflow: "PATIENT_VERIFICATION",
      state: "FAILED",
      allowedActions: ["VERIFY_PATIENT", "TRANSFER_TO_STAFF"],
      failureReason: "FIRST_NAME_NO_MATCH",
      context: {
        patientVerified: false,
        canDisclosePatientData: false
      }
    }
  });

  const decision = applyWorkflowTurnPolicies(call, {
    intent: "NEXT_APPOINTMENT",
    collectedFields: { firstName: "Mary" },
    toolRequest: { name: "TRANSFER_TO_STAFF", arguments: {} }
  });

  assert.equal(decision?.overrideResult?.toolRequest?.name, "VERIFY_PATIENT");
  assert.equal(decision?.overrideResult?.toolRequest?.arguments.firstName, "Mary");
});

test("does not retry the same identity value after a first-name mismatch", () => {
  const call = session({
    currentIntent: "BOOK_APPOINTMENT",
    collectedFields: { firstName: "Nancy" },
    pendingIdentityStatus: "NEEDS_NAME_SPELLING",
    workflowState: {
      contractVersion: 1,
      workflow: "PATIENT_VERIFICATION",
      state: "FAILED",
      allowedActions: ["VERIFY_PATIENT", "TRANSFER_TO_STAFF"],
      failureReason: "FIRST_NAME_NO_MATCH",
      context: {
        patientVerified: false,
        canDisclosePatientData: false
      }
    }
  });
  call.pendingActions.VERIFY_PATIENT_IDENTITY!.value = "Nancy";

  const decision = applyWorkflowTurnPolicies(call, {
    intent: "BOOK_APPOINTMENT",
    collectedFields: { firstName: "Nancy", lastName: "Jones" },
    toolRequest: {
      name: "VERIFY_PATIENT",
      arguments: { firstName: "Nancy" }
    }
  });

  assert.equal(decision?.overrideResult?.toolRequest, undefined);
  assert.match(decision?.overrideResult?.reply ?? "", /spell your first name/i);
});

test("clears the new-patient candidate after booking completes", () => {
  const call = session({ currentIntent: "BOOK_APPOINTMENT" });
  call.newPatientBookingCandidate = true;

  applyWorkflowToolResultPolicies(call, "BOOK_APPOINTMENT", {
    ok: true,
    workflowState: { state: "COMPLETED" }
  });

  assert.equal(call.newPatientBookingCandidate, false);
});

test("forces fresh appointment lookup for follow-up questions after confirmation", () => {
  const decision = applyWorkflowTurnPolicies(session({
    collectedFields: {
      firstName: "Kim",
      dob: "10/18/1999"
    },
    lastToolResults: {
      CONFIRM_APPOINTMENT: { ok: true }
    }
  }), {
    intent: "GET_NEXT_APPOINTMENT",
    reply: "They are all unconfirmed."
  });
  const result = decision?.overrideResult;

  assert.equal(result?.toolRequest?.name, "GET_NEXT_APPOINTMENT");
  assert.deepEqual(result?.toolRequest?.arguments, {
    firstName: "Kim",
    dob: "10/18/1999"
  });
});

test("does not force lookup when fresh appointment data is already present", () => {
  const original = {
    intent: "GET_NEXT_APPOINTMENT",
    reply: "You have one unconfirmed appointment."
  };

  const decision = applyWorkflowTurnPolicies(session({
    lastToolResults: {
      CONFIRM_APPOINTMENT: { ok: true },
      GET_NEXT_APPOINTMENT: { ok: true }
    }
  }), original);
  const result = decision?.overrideResult ?? original;

  assert.equal(result, original);
});

test("keeps booking workflow instead of premature staff transfer for booking details", () => {
  const decision = applyWorkflowTurnPolicies(session({
    currentIntent: "BOOK_APPOINTMENT",
    collectedFields: {
      firstName: "Nancy",
      lastName: "Jones",
      dob: "04/01/2000"
    }
  }), {
    intent: "TRANSFER_TO_STAFF",
    shouldEndCall: true,
    collectedFields: {
      bookingReason: "teeth whitening"
    },
    toolRequest: {
      name: "TRANSFER_TO_STAFF",
      arguments: {}
    }
  });

  assert.equal(decision?.overrideResult?.intent, "BOOK_APPOINTMENT");
  assert.equal(decision?.overrideResult?.shouldEndCall, false);
  assert.equal(decision?.overrideResult?.toolRequest?.name, "BOOK_APPOINTMENT");
  assert.deepEqual(decision?.overrideResult?.toolRequest?.arguments, {
    firstName: "Nancy",
    lastName: "Jones",
    dob: "04/01/2000",
    bookingReason: "teeth whitening"
  });
});

test("keeps booking workflow instead of premature staff transfer during active booking intent", () => {
  const decision = applyWorkflowTurnPolicies(session({
    currentIntent: "BOOK_APPOINTMENT",
    collectedFields: {
      firstName: "Nancy",
      lastName: "Jones",
      dob: "04/01/2000"
    }
  }), {
    intent: "delegate_to_staff",
    shouldEndCall: true,
    toolRequest: {
      name: "TRANSFER_TO_STAFF",
      arguments: {}
    }
  });

  assert.equal(decision?.overrideResult?.intent, "BOOK_APPOINTMENT");
  assert.equal(decision?.overrideResult?.shouldEndCall, false);
  assert.equal(decision?.overrideResult?.toolRequest?.name, "BOOK_APPOINTMENT");
  assert.deepEqual(decision?.overrideResult?.toolRequest?.arguments, {
    firstName: "Nancy",
    lastName: "Jones",
    dob: "04/01/2000"
  });
});

test("keeps booking open when backend still requires booking confirmation", () => {
  const decision = applyWorkflowTurnPolicies(session({
    currentIntent: "BOOK_APPOINTMENT",
    workflowState: {
      contractVersion: 1,
      workflow: "BOOK_APPOINTMENT",
      state: "REQUIRES_CONFIRMATION",
      requiredField: "callerConfirmedBooking",
      allowedActions: ["BOOK_APPOINTMENT"],
      context: {
        bookingReason: "dental cleaning",
        providerName: "David Johnson",
        slotDate: "09/08/2026",
        slotTime: "04:00 PM"
      }
    }
  }), {
    intent: "BOOK_APPOINTMENT",
    reply: "Your appointment is booked.",
    shouldEndCall: true
  });

  assert.deepEqual(decision?.repromptContext, { type: "BOOKING_CONFIRMATION" });
  assert.equal(decision?.overrideResult, undefined);
});

test("keeps recoverable availability failures in booking instead of transferring", () => {
  const decision = applyWorkflowTurnPolicies(session({
    currentIntent: "BOOK_APPOINTMENT",
    workflowState: {
      contractVersion: 1,
      workflow: "BOOK_APPOINTMENT",
      state: "NEEDS_SCHEDULING_PREFERENCE",
      requiredField: "datePreference",
      allowedActions: ["BOOK_APPOINTMENT"],
      failureReason: "No openings were found for the current booking details.",
      context: {
        bookingReason: "dental cleaning",
        providerName: "David Johnson"
      }
    }
  }), {
    intent: "TRANSFER_TO_STAFF",
    shouldEndCall: true,
    toolRequest: {
      name: "TRANSFER_TO_STAFF",
      arguments: {}
    }
  });

  assert.equal(decision?.overrideResult, undefined);
  assert.equal(decision?.repromptContext?.type, "BOOKING_AVAILABILITY_ALTERNATIVE");
  assert.match(decision?.instruction ?? "", /another date or available provider/i);
});

test("allows final booking request after explicit booking confirmation", () => {
  const original = {
    intent: "BOOK_APPOINTMENT",
    toolRequest: {
      name: "BOOK_APPOINTMENT",
      arguments: {
        callerConfirmedBooking: true
      }
    }
  };
  const decision = applyWorkflowTurnPolicies(session({
    currentIntent: "BOOK_APPOINTMENT",
    workflowState: {
      contractVersion: 1,
      workflow: "BOOK_APPOINTMENT",
      state: "REQUIRES_CONFIRMATION",
      requiredField: "callerConfirmedBooking",
      allowedActions: ["BOOK_APPOINTMENT"],
      context: {
        bookingReason: "dental cleaning",
        providerName: "David Johnson",
        slotDate: "09/08/2026",
        slotTime: "04:00 PM"
      }
    }
  }), original);

  assert.equal(decision, undefined);
});

test("prepares final booking from model authorization and saved details", () => {
  const callSession = session({
    currentIntent: "BOOK_APPOINTMENT",
    collectedFields: {
      firstName: "Nancy",
      lastName: "Jones",
      dob: "04/01/2000"
    },
    workflowState: {
      contractVersion: 1,
      workflow: "BOOK_APPOINTMENT",
      state: "REQUIRES_CONFIRMATION",
      requiredField: "callerConfirmedBooking",
      allowedActions: ["BOOK_APPOINTMENT"],
      context: {
        bookingReason: "Dental cleaning",
        providerName: "David Johnson",
        slotDate: "09/08/2026",
        slotTime: "04:00 PM"
      }
    }
  });
  const decision = applyWorkflowTurnPolicies(callSession, {
    intent: "BOOK_APPOINTMENT",
    callerAction: {
      speechAct: "AUTHORIZATION",
      workflowIntent: "BOOK_APPOINTMENT",
      requestedAction: "BOOK_APPOINTMENT",
      authorization: { stateChangingAction: "BOOK_APPOINTMENT", isExplicit: true }
    },
    toolRequest: {
      name: "BOOK_APPOINTMENT",
      arguments: {}
    }
  });

  assert.equal(decision?.overrideResult?.toolRequest?.name, "BOOK_APPOINTMENT");
  assert.equal(decision?.overrideResult?.toolRequest?.arguments.callerConfirmedBooking, true);
  assert.equal(decision?.overrideResult?.shouldEndCall, false);
  const tool = decision?.overrideResult?.toolRequest;
  assert.ok(tool);
  const prepared = prepareWorkflowTool(callSession, tool);
  assert.equal(prepared.arguments.firstName, "Nancy");
  assert.equal(prepared.arguments.dob, "04/01/2000");
  assert.equal(prepared.arguments.slotDate, "09/08/2026");
  assert.equal(prepared.arguments.slotTime, "04:00 PM");
  assert.equal(prepared.arguments.callerConfirmedBooking, true);
});

test("does not finalize booking when caller asks a question during booking confirmation", () => {
  const callSession = session({
    currentIntent: "BOOK_APPOINTMENT",
    workflowState: {
      contractVersion: 1,
      workflow: "BOOK_APPOINTMENT",
      state: "REQUIRES_CONFIRMATION",
      requiredField: "callerConfirmedBooking",
      allowedActions: ["BOOK_APPOINTMENT"],
      context: {
        bookingReason: "Dental cleaning",
        providerName: "David Johnson",
        slotDate: "09/08/2026",
        slotTime: "04:00 PM"
      }
    }
  });
  const decision = applyWorkflowTurnPolicies(callSession, {
    intent: "BOOK_APPOINTMENT",
    callerAction: {
      speechAct: "QUESTION",
      workflowIntent: "BOOK_APPOINTMENT",
      authorization: { stateChangingAction: null, isExplicit: false }
    },
    toolRequest: {
      name: "BOOK_APPOINTMENT",
      arguments: {}
    }
  });

  assert.equal(decision?.overrideResult?.toolRequest, undefined);
  assert.deepEqual(decision?.repromptContext, { type: "BOOKING_CONFIRMATION" });
});

test("retries appointment lookup instead of transferring when patient corrects identity", () => {
  const decision = applyWorkflowTurnPolicies(session({
    failureReason: "PATIENT_NOT_FOUND"
  }), {
    collectedFields: {
      firstName: "Kim",
      dob: "10/18/1999"
    },
    toolRequest: {
      name: "TRANSFER_TO_STAFF",
      arguments: {}
    }
  });
  const result = decision?.overrideResult;

  assert.equal(result?.toolRequest?.name, "GET_NEXT_APPOINTMENT");
  assert.deepEqual(result?.toolRequest?.arguments, {
    firstName: "Kim",
    dob: "10/18/1999"
  });
});

test("retries next-appointment lookup when required first name is already known", () => {
  const decision = applyWorkflowTurnPolicies(session({
    collectedFields: {
      firstName: "Nancy",
      dob: "04/01/2000"
    },
    workflowState: {
      contractVersion: 1,
      workflow: "NEXT_APPOINTMENT",
      state: "NEEDS_INPUT",
      requiredField: "firstName",
      allowedActions: ["GET_NEXT_APPOINTMENT"],
      context: {
        patientVerified: false,
        canDisclosePatientData: false
      }
    }
  }), {
    intent: "NEXT_APPOINTMENT",
    reply: "Could you please provide your first name?"
  });

  assert.equal(decision?.overrideResult?.toolRequest?.name, "GET_NEXT_APPOINTMENT");
  assert.deepEqual(decision?.overrideResult?.toolRequest?.arguments, {
    firstName: "Nancy",
    dob: "04/01/2000"
  });
});

test("retries confirm lookup when required date of birth is already known", () => {
  const decision = applyWorkflowTurnPolicies(session({
    currentIntent: "CONFIRM_APPOINTMENT",
    collectedFields: {
      firstName: "Nancy",
      lastName: "Jones",
      dob: "04/01/2000"
    },
    workflowState: {
      contractVersion: 1,
      workflow: "CONFIRM_APPOINTMENT",
      state: "NEEDS_INPUT",
      requiredField: "dob",
      allowedActions: ["GET_NEXT_APPOINTMENT"],
      context: {
        patientVerified: false,
        canDisclosePatientData: false
      }
    }
  }), {
    intent: "CONFIRM_APPOINTMENT",
    reply: "Could you please provide your date of birth?"
  });

  assert.equal(decision?.overrideResult?.toolRequest?.name, "GET_NEXT_APPOINTMENT");
  assert.deepEqual(decision?.overrideResult?.toolRequest?.arguments, {
    firstName: "Nancy",
    lastName: "Jones",
    dob: "04/01/2000"
  });
});

test("allows read-only appointment lookup during confirmation instead of policy reprompting", () => {
  const original = {
    intent: "CONFIRM_APPOINTMENT",
    callerAction: {
      speechAct: "QUESTION" as const,
      workflowIntent: "CONFIRM_APPOINTMENT" as const,
      requestedAction: "LOOKUP_APPOINTMENTS" as const,
      authorization: {
        stateChangingAction: null,
        isExplicit: false
      }
    },
    collectedFields: {
      selectedAppointmentDate: "September 3",
      selectedAppointmentTime: "around 10AM"
    },
    toolRequest: {
      name: "GET_NEXT_APPOINTMENT",
      arguments: {
        selectedAppointmentDate: "September 3",
        selectedAppointmentTime: "around 10AM"
      }
    }
  };

  const decision = applyWorkflowTurnPolicies(session({}), original);
  const result = decision?.overrideResult ?? original;

  assert.equal(decision?.repromptContext, undefined);
  assert.equal(result.toolRequest?.name, "GET_NEXT_APPOINTMENT");
});

test("keeps transfer when caller did not provide corrected identity", () => {
  const original = {
    callerAction: explicitStaffTransfer(),
    toolRequest: {
      name: "TRANSFER_TO_STAFF",
      arguments: {}
    }
  };

  const decision = applyWorkflowTurnPolicies(session({
    failureReason: "PATIENT_NOT_FOUND"
  }), original);
  const result = decision?.overrideResult ?? original;

  assert.equal(result, original);
});

test("does not infer appointment lookup from reply text alone", () => {
  const original = {
    reply: "Can you tell me which ones are unconfirmed?"
  };

  const decision = applyWorkflowTurnPolicies(session({
    lastToolResults: {
      CONFIRM_APPOINTMENT: { ok: true }
    }
  }), original);
  const result = decision?.overrideResult ?? original;

  assert.equal(result, original);
});

test("forces fresh appointment lookup when caller asks for appointment list after confirmation", () => {
  const decision = applyWorkflowTurnPolicies(session({
    collectedFields: {
      firstName: "Nancy",
      dob: "2000-04-01"
    },
    lastToolResults: {
      CONFIRM_APPOINTMENT: { ok: true }
    }
  }), {
    intent: "CONFIRM_APPOINTMENT",
    callerAction: {
      speechAct: "QUESTION",
      workflowIntent: "NEXT_APPOINTMENT",
      requestedAction: "LOOKUP_APPOINTMENTS",
      authorization: {
        stateChangingAction: null,
        isExplicit: false
      }
    },
    reply: "The September 4 appointment is not confirmed."
  });
  const result = decision?.overrideResult;

  assert.equal(result?.toolRequest?.name, "GET_NEXT_APPOINTMENT");
  assert.deepEqual(result?.toolRequest?.arguments, {
    firstName: "Nancy",
    dob: "2000-04-01"
  });
});

test("prefers confirmation execution over fallback when confirmation is ready", () => {
  const decision = applyWorkflowTurnPolicies(session({
    pendingAppointmentId: 502,
    pendingStatus: "READY_TO_EXECUTE"
  }), {
    toolRequest: {
      name: "TRANSFER_TO_STAFF",
      arguments: {}
    }
  });
  const result = decision?.overrideResult;

  assert.equal(result?.toolRequest?.name, "CONFIRM_APPOINTMENT");
  assert.equal(result?.toolRequest?.arguments.appointmentId, 502);
  assert.equal(result?.toolRequest?.arguments.callerConfirmedSelectedAppointment, undefined);
});

test("executes confirmation once selection and caller authorization are already structured", () => {
  const decision = applyWorkflowTurnPolicies(session({
    pendingAppointmentId: 503,
    pendingStatus: "READY_TO_EXECUTE"
  }), {
    reply: "I have your confirmation."
  });
  const result = decision?.overrideResult;

  assert.equal(result?.toolRequest?.name, "CONFIRM_APPOINTMENT");
  assert.equal(result?.toolRequest?.arguments.appointmentId, 503);
});

test("treats confirmation questions as non-authorizing even when the model requested confirmation", () => {
  const decision = applyWorkflowTurnPolicies(session({
    pendingAppointmentId: 503,
    pendingStatus: "AWAITING_CALLER_CONFIRMATION",
    selectionOptions: [
      option(503, "9:20 AM on Wednesday, September 2, 2026")
    ]
  }), {
    intent: "CONFIRM_APPOINTMENT",
    callerAction: {
      speechAct: "QUESTION",
      workflowIntent: "CONFIRM_APPOINTMENT",
      requestedAction: "CONFIRM_SELECTED_APPOINTMENT",
      authorization: {
        stateChangingAction: null,
        isExplicit: false
      }
    },
    toolRequest: {
      name: "CONFIRM_APPOINTMENT",
      arguments: {
        appointmentId: 503
      }
    },
    reply: "Your appointment has been confirmed."
  });

  assert.equal(decision?.overrideResult, undefined);
  assert.equal(decision?.repromptContext?.type, "CHOOSE_CONFIRMABLE_APPOINTMENT");
  assert.match(decision?.instruction ?? "", /not authorizing/i);
});

test("answers from completed confirmation state instead of re-confirming", () => {
  const decision = applyWorkflowTurnPolicies(session({
    workflowState: {
      contractVersion: 1,
      workflow: "CONFIRM_APPOINTMENT",
      state: "COMPLETED",
      allowedActions: [],
      context: {
        selectedAppointmentId: 503,
        alreadyConfirmed: false
      }
    }
  }), {
    intent: "CONFIRM_APPOINTMENT",
    reply: "I am confirming your appointment now."
  });

  assert.equal(decision?.overrideResult, undefined);
  assert.equal(decision?.repromptContext?.type, "CONFIRMATION_COMPLETED");
  assert.match(decision?.instruction ?? "", /already completed/i);
});

test("allows a new appointment lookup after completed confirmation", () => {
  const original = {
    intent: "CONFIRM_APPOINTMENT",
    toolRequest: {
      name: "GET_NEXT_APPOINTMENT",
      arguments: {
        firstName: "Nancy",
        lastName: "Jones",
        dob: "2000-04-01"
      }
    }
  };

  const decision = applyWorkflowTurnPolicies(session({
    workflowState: {
      contractVersion: 1,
      workflow: "CONFIRM_APPOINTMENT",
      state: "COMPLETED",
      allowedActions: [],
      context: {
        selectedAppointmentId: 193,
        alreadyConfirmed: false
      }
    }
  }), original);

  assert.equal(decision, undefined);
});

test("prefers confirmation flow over fallback transfer when a selected appointment exists", () => {
  const decision = applyWorkflowTurnPolicies(session({
    pendingAppointmentId: 503,
    pendingStatus: "AWAITING_CALLER_CONFIRMATION",
    selectionOptions: [
      option(502, "9:20 AM on Friday, August 21, 2026"),
      option(503, "10:00 AM on Monday, August 24, 2026")
    ]
  }), {
    toolRequest: {
      name: "TRANSFER_TO_STAFF",
      arguments: {}
    }
  });

  assert.equal(decision?.overrideResult, undefined);
  assert.equal(decision?.repromptContext?.type, "CONFIRM_SELECTED_APPOINTMENT");
  assert.equal(decision?.repromptContext?.selectedAppointment?.appointmentId, 503);
});

test("allows explicit caller staff transfer during confirmation flow", () => {
  const callSession = session({
    pendingAppointmentId: 503,
    pendingStatus: "AWAITING_CALLER_CONFIRMATION",
    selectionOptions: [
      option(502, "9:20 AM on Friday, August 21, 2026"),
      option(503, "10:00 AM on Monday, August 24, 2026")
    ]
  });
  callSession.transcript.push({
    speaker: "patient",
    text: "Please transfer me to the front desk instead.",
    at: "2026-08-19T00:01:00.000Z"
  });

  const original = {
    callerAction: explicitStaffTransfer(),
    toolRequest: {
      name: "TRANSFER_TO_STAFF",
      arguments: {}
    }
  };
  const decision = applyWorkflowTurnPolicies(callSession, original);
  const result = decision?.overrideResult ?? original;

  assert.equal(result, original);
});

test("allows explicit caller staff transfer intent during confirmation flow", () => {
  const callSession = session({
    pendingAppointmentId: 503,
    pendingStatus: "AWAITING_CALLER_CONFIRMATION",
    selectionOptions: [
      option(502, "9:20 AM on Friday, August 21, 2026"),
      option(503, "10:00 AM on Monday, August 24, 2026")
    ]
  });
  callSession.transcript.push({
    speaker: "patient",
    text: "I want to talk to someone in the office.",
    at: "2026-08-19T00:01:00.000Z"
  });

  const original = {
    intent: "TRANSFER_TO_STAFF",
    callerAction: explicitStaffTransfer(),
    reply: "I will connect you to the office."
  };
  const decision = applyWorkflowTurnPolicies(callSession, original);
  const result = decision?.overrideResult ?? original;

  assert.equal(result, original);
});

test("asks the caller to choose instead of falling back when confirmable options exist", () => {
  const decision = applyWorkflowTurnPolicies(session({
    selectionOptions: [
      option(502, "9:20 AM on Friday, August 21, 2026"),
      option(503, "10:00 AM on Monday, August 24, 2026")
    ]
  }), {
    toolRequest: {
      name: "TRANSFER_TO_STAFF",
      arguments: {}
    }
  });

  assert.equal(decision?.overrideResult, undefined);
  assert.equal(decision?.repromptContext?.type, "CHOOSE_CONFIRMABLE_APPOINTMENT");
  assert.equal(decision?.repromptContext?.options?.length, 2);
});

test("allows explicit caller staff transfer during patient-not-found recovery", () => {
  const callSession = session({
    collectedFields: {
      firstName: "Kima",
      lastName: "Miller"
    },
    failureReason: "PATIENT_NOT_FOUND"
  });
  callSession.transcript.push({
    speaker: "patient",
    text: "Can someone in the office handle this?",
    at: "2026-08-19T00:01:00.000Z"
  });

  const original = {
    callerAction: explicitStaffTransfer(),
    toolRequest: {
      name: "TRANSFER_TO_STAFF",
      arguments: {}
    }
  };
  const decision = applyWorkflowTurnPolicies(callSession, original);
  const result = decision?.overrideResult ?? original;

  assert.equal(result, original);
});

test("uses completed confirmation state after a successful confirm tool result", () => {
  const decision = applyWorkflowToolResultPolicies(session({
    workflowState: {
      contractVersion: 1,
      workflow: "CONFIRM_APPOINTMENT",
      state: "COMPLETED",
      allowedActions: [],
      context: {
        selectedAppointmentId: 503,
        alreadyConfirmed: false
      }
    }
  }), "CONFIRM_APPOINTMENT", {
    ok: true
  });

  assert.equal(decision?.repromptContext?.type, "CONFIRMATION_COMPLETED");
  assert.match(decision?.instruction ?? "", /already completed successfully/i);
});

test("forces appointment choice after confirm-intent lookup with multiple confirmable appointments", () => {
  const decision = applyWorkflowToolResultPolicies(session({
    currentIntent: "CONFIRM_APPOINTMENT",
    workflowState: {
      contractVersion: 1,
      workflow: "NEXT_APPOINTMENT",
      state: "COMPLETED",
      allowedActions: [],
      context: {
        patientVerified: true,
        canDisclosePatientData: true
      }
    },
    selectionOptions: [
      option(502, "9:20 AM on Friday, August 29, 2026"),
      option(503, "10:00 AM on Saturday, August 30, 2026")
    ]
  }), "GET_NEXT_APPOINTMENT", {
    ok: true
  });

  assert.equal(decision?.repromptContext?.type, "CHOOSE_CONFIRMABLE_APPOINTMENT");
  assert.match(decision?.instruction ?? "", /multiple confirmable appointments/i);
});

test("executes confirmation after lookup when selection and authorization are already available", () => {
  const decision = applyWorkflowToolResultPolicies(session({
    currentIntent: "CONFIRM_APPOINTMENT",
    pendingAppointmentId: 503,
    pendingStatus: "READY_TO_EXECUTE",
    workflowState: {
      contractVersion: 1,
      workflow: "NEXT_APPOINTMENT",
      state: "COMPLETED",
      allowedActions: [],
      context: {
        patientVerified: true,
        canDisclosePatientData: true
      }
    }
  }), "GET_NEXT_APPOINTMENT", {
    ok: true
  });

  assert.equal(decision?.overrideResult?.toolRequest?.name, "CONFIRM_APPOINTMENT");
  assert.equal(decision?.overrideResult?.toolRequest?.arguments.appointmentId, 503);
});

test("does not ask for last-name spelling before a patient-not-found staff transfer", () => {
  const decision = applyWorkflowTurnPolicies(session({
    collectedFields: {
      firstName: "Kima",
      lastName: "Miller"
    },
    failureReason: "PATIENT_NOT_FOUND"
  }), {
    toolRequest: {
      name: "TRANSFER_TO_STAFF",
      arguments: {}
    }
  });

  assert.equal(decision?.overrideResult, undefined);
  assert.equal(decision, undefined);
});

test("does not ask for last-name spelling after lookup failure", () => {
  const decision = applyWorkflowToolResultPolicies(session({
    currentIntent: "NEXT_APPOINTMENT",
    collectedFields: {
      firstName: "Kima",
      lastName: "Miller"
    },
    workflowState: {
      contractVersion: 1,
      workflow: "NEXT_APPOINTMENT",
      state: "FAILED",
      allowedActions: ["GET_NEXT_APPOINTMENT", "TRANSFER_TO_STAFF"],
      failureReason: "PATIENT_NOT_FOUND",
      context: {
        patientVerified: false,
        canDisclosePatientData: false
      }
    }
  }), "GET_NEXT_APPOINTMENT", { ok: true });

  assert.equal(decision, undefined);
});

function session(input: {
  currentIntent?: string;
  collectedFields?: Record<string, unknown>;
  lastToolResults?: Record<string, unknown>;
  failureReason?: string;
  pendingAppointmentId?: unknown;
  pendingStatus?: "AWAITING_CALLER_CONFIRMATION" | "READY_TO_EXECUTE";
  pendingIdentityStatus?: "NEEDS_NAME_SPELLING" | "NEEDS_DOB_CORRECTION";
  selectionOptions?: Array<{ appointmentId: unknown; appointmentDate: string; doctorName?: string }>;
  workflowState?: CallSession["workflowState"];
}): CallSession {
  return {
    callSid: "CA-test",
    officeCode: "OFC001",
    startedAt: "2026-08-17T00:00:00.000Z",
    lastActivityAt: "2026-08-17T00:00:00.000Z",
    transcript: [],
    collectedFields: input.collectedFields ?? {},
    lastToolResults: input.lastToolResults ?? {},
    pendingActions: {
      ...(input.pendingAppointmentId ? {
        CONFIRM_APPOINTMENT: {
          appointmentId: input.pendingAppointmentId,
          status: input.pendingStatus ?? "AWAITING_CALLER_CONFIRMATION",
          createdAt: "2026-08-19T00:00:00.000Z"
        }
      } : {}),
      ...(input.pendingIdentityStatus ? {
        VERIFY_PATIENT_IDENTITY: {
          status: input.pendingIdentityStatus,
          createdAt: "2026-08-19T00:00:00.000Z"
        }
      } : {})
    },
    appointmentSelections: input.selectionOptions ? {
      CONFIRM_APPOINTMENT: {
        options: input.selectionOptions.map((selection) => ({
          ...selection,
          source: selection
        })),
        createdAt: "2026-08-19T00:00:00.000Z"
      }
    } : {},
    currentIntent: input.currentIntent ?? "CONFIRM_APPOINTMENT",
    workflowState: input.workflowState ?? (input.failureReason ? {
      contractVersion: 1,
      workflow: "NEXT_APPOINTMENT",
      state: "FAILED",
      allowedActions: ["GET_NEXT_APPOINTMENT", "TRANSFER_TO_STAFF"],
      failureReason: input.failureReason,
      context: {
        patientVerified: false,
        canDisclosePatientData: false
      }
    } : undefined)
  };
}

function option(appointmentId: unknown, appointmentDate: string, doctorName = "Dr. David Johnson") {
  return {
    appointmentId,
    appointmentDate,
    doctorName
  };
}

function explicitStaffTransfer() {
  return {
    speechAct: "REQUEST" as const,
    workflowIntent: "TRANSFER_TO_STAFF" as const,
    requestedAction: "TRANSFER_TO_STAFF" as const,
    authorization: {
      stateChangingAction: null,
      isExplicit: true
    }
  };
}
