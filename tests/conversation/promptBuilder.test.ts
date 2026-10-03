import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../../src/conversation/promptBuilder.js";
import { CallSession } from "../../src/calls/callSession.js";
import { modelToolContracts } from "../../src/tools/modelToolRegistry.js";
import { ToolExecutor } from "../../src/tools/toolExecutor.js";
import { SpringBootClient } from "../../src/backend/springBootClient.js";

test("builds a compact workflow-oriented prompt", () => {
  const prompt = buildSystemPrompt(session());

  assert.match(prompt, /Workflow protocol:/);
  assert.match(prompt, /Tool contracts:/);
  assert.match(prompt, /BOOK_APPOINTMENT tool guidance:/);
  assert.match(prompt, /callerAction\.patientTypeChoice as NEW_PATIENT or RETURNING_PATIENT/i);
  assert.match(prompt, /callerAction\.bookingPatientSubjectChoice may be CALLER, SOMEONE_ELSE, or null/i);
  assert.match(prompt, /Booking: identify caller vs other/i);
  assert.match(prompt, /Field lists: string arrays; empty means \[\]/i);
  assert.match(prompt, /No tool call: toolRequest \{\}; otherwise include name and arguments/i);
  assert.match(prompt, /END_CALL only for a terminal farewell.*Workflow completion alone never ends a call/i);
  assert.match(prompt, /GET_NEXT_APPOINTMENT tool guidance:/);
  assert.match(prompt, /CONFIRM_APPOINTMENT tool guidance:/);
  assert.match(prompt, /VERIFY_PATIENT tool guidance:/);
  assert.match(prompt, /GET_INSURANCE_POLICY tool guidance:/);
  assert.match(prompt, /Do not infer that a listed or accepted plan guarantees coverage/i);
  assert.match(prompt, /TRANSFER_TO_STAFF tool guidance:/);
  assert.match(prompt, /transfer immediately without asking them to confirm it again/i);
  assert.match(prompt, /Only in a booking verification state that asks whether to continue as a new patient/i);
  assert.match(prompt, /BOOK_APPOINTMENT/);
  assert.match(prompt, /Use TRANSFER_TO_STAFF for every staff handoff/);
  assert.doesNotMatch(prompt, /CREATE_HANDOFF_REQUEST/);
  assert.doesNotMatch(prompt, /SAVE_CALL_SUMMARY/);
  assert.doesNotMatch(prompt, /GETevant|reldo/);
  assert.match(prompt, /"requiredArguments":\["firstName","dob","bookingReason","appointmentTypeId"\]/);
  assert.match(prompt, /use exact fields.*dob/i);
  assert.match(prompt, /without asking whether the caller is new/i);
  assert.match(prompt, /do not ask for or require last name/i);
  assert.match(prompt, /resolve the closest eligible appointment type/i);
  assert.match(prompt, /For new patients/i);
  assert.match(prompt, /collect firstName, lastName, dob, gender, patientEmail, and patientPhone/i);
  assert.match(prompt, /Ask directly for gender/i);
  assert.match(prompt, /spell first and last names back once, and ask one confirmation/i);
  assert.match(prompt, /accept a corrected name as final without reconfirming/i);
  assert.match(prompt, /confirm email and phone once after read-back/i);
  assert.match(prompt, /After acceptance, do not ask confirmed details again unless corrected/i);
  assert.match(prompt, /Spell first and last names back once and ask one confirmation/i);
  assert.match(prompt, /Use session\.fromNumber when appropriate and confirm its last four digits/i);
  assert.match(prompt, /never send the literal text fromNumber as patientPhone/i);
  assert.match(prompt, /Accept clear DOB without confirmation/i);
  assert.match(prompt, /day after tomorrow.*exactly two calendar days/i);
  assert.match(prompt, /fromDate\/toDate/i);
  assert.match(prompt, /For a single requested date such as today, tomorrow, or a named calendar date/i);
  assert.match(prompt, /maximum allowed difference between fromDate and toDate is 7 days/i);
  assert.match(prompt, /Appointment type resolution is mandatory before every BOOK_APPOINTMENT request/i);
  assert.match(prompt, /Never submit BOOK_APPOINTMENT with a missing, null, string-valued, or cross-category appointmentTypeId/i);
  assert.match(prompt, /present directly inside toolRequest\.arguments/i);
  assert.match(prompt, /Node searches the next seven-day window/i);
  assert.match(prompt, /explicit BOOK_APPOINTMENT authorization referencing that slot/i);
  assert.match(prompt, /Node books after backend acceptance; no extra permission question/i);
  assert.match(prompt, /office context as a closed-world source of truth/i);
  assert.match(prompt, /do not guess, infer, or use general knowledge/i);
  assert.match(prompt, /never present an absent or ambiguous office fact as true/i);
  assert.ok(prompt.length < 20000, `prompt is too long: ${prompt.length}`);
});

test("uses the office-local current date in the prompt", () => {
  const callSession = session();
  callSession.startedAt = "2026-08-17T02:30:00.000Z";
  callSession.officeContext!.timezone = "America/Los_Angeles";

  assert.match(buildSystemPrompt(callSession), /Current date: 2026-08-16/);
  assert.match(buildSystemPrompt(callSession), /today=2026-08-16, tomorrow=08\/17\/2026, day after tomorrow=08\/18\/2026/);
});

test("includes appointment type eligibility and context-only provider instructions", () => {
  const callSession = session();
  callSession.officeContext!.appointmentTypes = {
    RETURNING_PATIENT: [{ appointmentTypeId: 12, type: "Cleaning", duration: 60 }],
    NEW_PATIENT: [{ appointmentTypeId: 13, type: "Initial exam", duration: 90 }]
  };
  const prompt = buildSystemPrompt(callSession);
  assert.ok(prompt.includes(JSON.stringify(callSession.officeContext!.appointmentTypes)));
  assert.match(prompt, /caller.s new-or-returning choice routes booking/i);
  assert.match(prompt, /appointmentTypes catalog/);
  assert.match(prompt, /copy names exactly/);
  assert.match(prompt, /Preserve bookingReason/);
  assert.doesNotMatch(prompt, /selected from office context providers or backend providerOptions/);
});

test("model prompt contracts match the tools accepted by the executor", () => {
  const prompt = buildSystemPrompt(session());
  const contractText = prompt.split("Tool contracts:\n")[1]?.split("\nUse TRANSFER_TO_STAFF")[0];
  assert.ok(contractText, "prompt should contain serialized tool contracts");
  const advertisedTools = (JSON.parse(contractText) as Array<{ name: string }>).map(({ name }) => name);
  const executor = new ToolExecutor({} as SpringBootClient);

  assert.deepEqual(advertisedTools, modelToolContracts.map(({ name }) => name));
  for (const toolName of advertisedTools) {
    assert.equal(executor.isAllowed(toolName), true, `${toolName} should be executable`);
  }
  assert.equal(advertisedTools.includes("SAVE_CALL_SUMMARY"), false);
  assert.equal(executor.isAllowed("SAVE_CALL_SUMMARY"), false);
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
