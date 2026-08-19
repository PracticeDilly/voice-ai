import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../../src/conversation/promptBuilder.js";
import { CallSession } from "../../src/calls/callSession.js";

test("builds a compact workflow-oriented prompt", () => {
  const prompt = buildSystemPrompt(session());

  assert.match(prompt, /Workflow protocol:/);
  assert.match(prompt, /Tool contracts:/);
  assert.match(prompt, /CREATE_HANDOFF_REQUEST consentSource values/);
  assert.doesNotMatch(prompt, /GETevant|reldo/);
  assert.ok(prompt.length < 5500, `prompt is too long: ${prompt.length}`);
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
