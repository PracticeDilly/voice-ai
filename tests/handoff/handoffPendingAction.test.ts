import assert from "node:assert/strict";
import test from "node:test";
import {
  consumePendingHandoffRequest,
  syncPendingHandoffRequest
} from "../../src/handoff/handoffPendingAction.js";
import { CallSession } from "../../src/calls/callSession.js";

test("creates pending handoff from structured caller consent", () => {
  const callSession = session();

  syncPendingHandoffRequest(callSession, {
    name: "CREATE_HANDOFF_REQUEST",
    arguments: {
      callerConsent: true,
      consentSource: "CALLER_EXPLICIT_REQUEST"
    }
  });

  assert.deepEqual(callSession.pendingActions.CREATE_HANDOFF_REQUEST?.status, "READY_TO_EXECUTE");
  assert.equal(callSession.pendingActions.CREATE_HANDOFF_REQUEST?.consentSource, "CALLER_EXPLICIT_REQUEST");
});

test("does not create pending handoff for malformed consent", () => {
  const callSession = session();

  syncPendingHandoffRequest(callSession, {
    name: "CREATE_HANDOFF_REQUEST",
    arguments: {
      callerConsent: true,
      consentSource: "MODEL_INFERRED"
    }
  });

  assert.equal(callSession.pendingActions.CREATE_HANDOFF_REQUEST, undefined);
});

test("consumes pending handoff after successful handoff creation", () => {
  const callSession = session();
  callSession.pendingActions.CREATE_HANDOFF_REQUEST = {
    status: "READY_TO_EXECUTE",
    consentSource: "CALLER_EXPLICIT_REQUEST",
    createdAt: "2026-08-17T00:00:00.000Z"
  };

  consumePendingHandoffRequest(callSession, "CREATE_HANDOFF_REQUEST", {
    name: "CREATE_HANDOFF_REQUEST",
    ok: true
  });

  assert.equal(callSession.pendingActions.CREATE_HANDOFF_REQUEST, undefined);
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
