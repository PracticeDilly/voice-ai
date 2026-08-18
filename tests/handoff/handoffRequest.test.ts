import assert from "node:assert/strict";
import test from "node:test";
import { validateHandoffRequest } from "../../src/handoff/handoffRequest.js";
import { ToolRequest } from "../../src/backend/springBootClient.js";
import { CallSession } from "../../src/calls/callSession.js";

test("rejects staff follow-up when caller has not accepted it", () => {
  assert.match(validateHandoffRequest(session(), handoff()) ?? "", /requires caller consent/);
});

test("allows staff follow-up when backend requires handoff", () => {
  assert.equal(validateHandoffRequest(session("HANDOFF_REQUIRED"), handoff()), undefined);
});

test("allows staff follow-up when caller explicitly accepts it", () => {
  assert.equal(validateHandoffRequest(session("FAILED", "CALLER_ACCEPTED_FOLLOWUP_OFFER"), handoff()), undefined);
});

test("allows staff follow-up when caller directly requests it", () => {
  assert.equal(validateHandoffRequest(session("FAILED", "CALLER_EXPLICIT_REQUEST"), handoff()), undefined);
});

test("rejects structured consent before it is recorded as pending action", () => {
  assert.match(validateHandoffRequest(session(), handoff({
    callerConsent: true,
    consentSource: "CALLER_ACCEPTED_FOLLOWUP_OFFER"
  })) ?? "", /requires caller consent/);
});

test("rejects consent source without explicit consent flag", () => {
  assert.match(validateHandoffRequest(session(), handoff({
    consentSource: "CALLER_ACCEPTED_FOLLOWUP_OFFER"
  })) ?? "", /requires caller consent/);
});

test("does not restrict unrelated tools", () => {
  assert.equal(validateHandoffRequest(session(), {
    name: "GET_NEXT_APPOINTMENT",
    arguments: {}
  }), undefined);
});

function handoff(argumentsOverride: Record<string, unknown> = {}): ToolRequest {
  return {
    name: "CREATE_HANDOFF_REQUEST",
    arguments: argumentsOverride
  };
}

function session(
  state = "FAILED",
  pendingConsentSource?: "CALLER_EXPLICIT_REQUEST" | "CALLER_ACCEPTED_FOLLOWUP_OFFER"
): CallSession {
  return {
    callSid: "CA-test",
    officeCode: "OFC001",
    startedAt: "2026-08-17T00:00:00.000Z",
    lastActivityAt: "2026-08-17T00:00:00.000Z",
    patientVerified: false,
    transcript: [],
    collectedFields: {},
    lastToolResults: {},
    pendingActions: pendingConsentSource ? {
      CREATE_HANDOFF_REQUEST: {
        status: "READY_TO_EXECUTE",
        consentSource: pendingConsentSource,
        createdAt: "2026-08-17T00:00:00.000Z"
      }
    } : {},
    workflowState: {
      contractVersion: 1,
      workflow: "NEXT_APPOINTMENT",
      state,
      allowedActions: ["GET_NEXT_APPOINTMENT", "CREATE_HANDOFF_REQUEST"],
      failureReason: state === "FAILED" ? "PATIENT_NOT_FOUND" : undefined,
      context: {
        patientVerified: false,
        canDisclosePatientData: false
      }
    }
  };
}
