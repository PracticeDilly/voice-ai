import assert from "node:assert/strict";
import test from "node:test";
import { applyDeterministicToolPolicy } from "../../src/conversation/toolPolicy.js";
import { CallSession } from "../../src/calls/callSession.js";

test("forces fresh appointment lookup for follow-up questions after confirmation", () => {
  const result = applyDeterministicToolPolicy(session({
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

  assert.equal(result.toolRequest?.name, "GET_NEXT_APPOINTMENT");
  assert.deepEqual(result.toolRequest?.arguments, {
    firstName: "Kim",
    dob: "10/18/1999"
  });
});

test("does not force lookup when fresh appointment data is already present", () => {
  const original = {
    intent: "GET_NEXT_APPOINTMENT",
    reply: "You have one unconfirmed appointment."
  };

  const result = applyDeterministicToolPolicy(session({
    lastToolResults: {
      CONFIRM_APPOINTMENT: { ok: true },
      GET_NEXT_APPOINTMENT: { ok: true }
    }
  }), original);

  assert.equal(result, original);
});

test("retries appointment lookup instead of creating handoff when patient corrects identity", () => {
  const result = applyDeterministicToolPolicy(session({
    failureReason: "PATIENT_NOT_FOUND"
  }), {
    collectedFields: {
      firstName: "Kim",
      dob: "10/18/1999"
    },
    toolRequest: {
      name: "CREATE_HANDOFF_REQUEST",
      arguments: {}
    }
  });

  assert.equal(result.toolRequest?.name, "GET_NEXT_APPOINTMENT");
  assert.deepEqual(result.toolRequest?.arguments, {
    firstName: "Kim",
    dob: "10/18/1999"
  });
});

test("keeps handoff when caller did not provide corrected identity", () => {
  const original = {
    toolRequest: {
      name: "CREATE_HANDOFF_REQUEST",
      arguments: {}
    }
  };

  const result = applyDeterministicToolPolicy(session({
    failureReason: "PATIENT_NOT_FOUND"
  }), original);

  assert.equal(result, original);
});

test("does not infer appointment lookup from reply text alone", () => {
  const original = {
    reply: "Can you tell me which ones are unconfirmed?"
  };

  const result = applyDeterministicToolPolicy(session({
    lastToolResults: {
      CONFIRM_APPOINTMENT: { ok: true }
    }
  }), original);

  assert.equal(result, original);
});

function session(input: {
  collectedFields?: Record<string, unknown>;
  lastToolResults?: Record<string, unknown>;
  failureReason?: string;
}): CallSession {
  return {
    callSid: "CA-test",
    officeCode: "OFC001",
    startedAt: "2026-08-17T00:00:00.000Z",
    lastActivityAt: "2026-08-17T00:00:00.000Z",
    patientVerified: false,
    transcript: [],
    collectedFields: input.collectedFields ?? {},
    lastToolResults: input.lastToolResults ?? {},
    pendingActions: {},
    appointmentSelections: {},
    workflowState: input.failureReason ? {
      contractVersion: 1,
      workflow: "NEXT_APPOINTMENT",
      state: "FAILED",
      allowedActions: ["GET_NEXT_APPOINTMENT", "CREATE_HANDOFF_REQUEST"],
      failureReason: input.failureReason,
      context: {
        patientVerified: false,
        canDisclosePatientData: false
      }
    } : undefined
  };
}
