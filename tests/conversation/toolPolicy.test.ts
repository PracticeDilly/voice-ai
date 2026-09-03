import assert from "node:assert/strict";
import test from "node:test";
import { CallSession } from "../../src/calls/callSession.js";
import { applyWorkflowToolResultPolicies, applyWorkflowTurnPolicies } from "../../src/workflows/shared/workflowRegistry.js";

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

test("asks the caller to spell the name before falling back to staff on patient-not-found", () => {
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
  assert.match(decision?.instruction ?? "", /spell the name/i);
  assert.equal(decision?.repromptContext?.type, "ASK_CALLER_TO_SPELL_NAME");
  assert.equal(decision?.repromptContext?.identity?.firstName, "Kima");
  assert.equal(decision?.repromptContext?.identity?.lastName, "Miller");
});

test("asks the caller to spell the name after lookup failure before falling back to staff", () => {
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

  assert.match(decision?.instruction ?? "", /spell the name/i);
  assert.equal(decision?.repromptContext?.type, "ASK_CALLER_TO_SPELL_NAME");
});

function session(input: {
  currentIntent?: string;
  collectedFields?: Record<string, unknown>;
  lastToolResults?: Record<string, unknown>;
  failureReason?: string;
  pendingAppointmentId?: unknown;
  pendingStatus?: "AWAITING_CALLER_CONFIRMATION" | "READY_TO_EXECUTE";
  pendingIdentityStatus?: "NEEDS_NAME_SPELLING";
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
