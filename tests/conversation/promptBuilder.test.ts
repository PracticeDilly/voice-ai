import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../../src/conversation/promptBuilder.js";
import { CallSession } from "../../src/calls/callSession.js";

test("builds a compact workflow-oriented prompt", () => {
  const prompt = buildSystemPrompt(session());

  assert.match(prompt, /Workflow protocol:/);
  assert.match(prompt, /Tool contracts:/);
  assert.match(prompt, /BOOK_APPOINTMENT/);
  assert.match(prompt, /Use TRANSFER_TO_STAFF for every staff handoff/);
  assert.doesNotMatch(prompt, /CREATE_HANDOFF_REQUEST/);
  assert.doesNotMatch(prompt, /GETevant|reldo/);
  assert.ok(prompt.length < 8500, `prompt is too long: ${prompt.length}`);
});

test("includes appointment type eligibility and context-only provider instructions", () => {
  const callSession = session();
  callSession.officeContext!.appointmentTypes = {
    RETURNING_PATIENT: [{ appointmentTypeId: 12, type: "Cleaning", duration: 60 }],
    NEW_PATIENT: [{ appointmentTypeId: 13, type: "Initial exam", duration: 90 }]
  };
  const prompt = buildSystemPrompt(callSession);
  assert.ok(prompt.includes(JSON.stringify(callSession.officeContext!.appointmentTypes)));
  assert.match(prompt, /Never select from NEW_PATIENT/);
  assert.match(prompt, /copy their names exactly/);
  assert.match(prompt, /Preserve bookingReason/);
  assert.doesNotMatch(prompt, /selected from office context providers or backend providerOptions/);
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
    appointmentSelections: {},
    officeContext: {
      officeCode: "OFC001",
      officeName: "Test Dental",
      timezone: "America/New_York",
      allowedActions: ["GET_NEXT_APPOINTMENT", "CONFIRM_APPOINTMENT"],
      supportedIntents: ["NEXT_APPOINTMENT", "CONFIRM_APPOINTMENT"],
      facts: ["Parking is available."]
    }
  };
}
