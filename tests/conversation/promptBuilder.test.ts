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
  assert.match(prompt, /"requiredArguments":\["firstName","dob","bookingReason","appointmentTypeId"\]/);
  assert.match(prompt, /Store DOB as dob, never dateOfBirth/);
  assert.match(prompt, /without asking whether the caller is new/i);
  assert.match(prompt, /do not ask for or require last name/i);
  assert.match(prompt, /always derive the closest eligible appointment type/i);
  assert.match(prompt, /For new patients/i);
  assert.match(prompt, /fromDate\/toDate/i);
  assert.match(prompt, /Search from the requested date through seven calendar days after it/i);
  assert.match(prompt, /maximum allowed difference between fromDate and toDate is 7 days/i);
  assert.ok(prompt.length < 11000, `prompt is too long: ${prompt.length}`);
});

test("uses the office-local current date in the prompt", () => {
  const callSession = session();
  callSession.startedAt = "2026-08-17T02:30:00.000Z";
  callSession.officeContext!.timezone = "America/Los_Angeles";

  assert.match(buildSystemPrompt(callSession), /Current date: 2026-08-16/);
});

test("includes appointment type eligibility and context-only provider instructions", () => {
  const callSession = session();
  callSession.officeContext!.appointmentTypes = {
    RETURNING_PATIENT: [{ appointmentTypeId: 12, type: "Cleaning", duration: 60 }],
    NEW_PATIENT: [{ appointmentTypeId: 13, type: "Initial exam", duration: 90 }]
  };
  const prompt = buildSystemPrompt(callSession);
  assert.ok(prompt.includes(JSON.stringify(callSession.officeContext!.appointmentTypes)));
  assert.match(prompt, /Backend determines RETURNING_PATIENT vs NEW_PATIENT/);
  assert.match(prompt, /appointmentTypes catalog/);
  assert.match(prompt, /copy names exactly/);
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
