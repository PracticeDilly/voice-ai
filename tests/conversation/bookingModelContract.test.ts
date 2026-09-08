import assert from "node:assert/strict";
import test from "node:test";
import { CallSessionStore } from "../../src/calls/callSession.js";
import { ModelClient, ModelTurnResult } from "../../src/conversation/modelClient.js";
import { BookingWorkflowError, bookingModelContractError } from "../../src/workflows/bookAppointment/bookingModelContract.js";
import { prepareBookingFollowup } from "../../src/workflows/bookAppointment/bookingFollowup.js";
import { AiReceptionistOrchestrator } from "../../src/conversation/aiReceptionistOrchestrator.js";
import { ToolExecutor } from "../../src/tools/toolExecutor.js";
import { SpringBootClient, ToolRequest } from "../../src/backend/springBootClient.js";

const validFields = { firstName: "Nancy", dob: "04/01/2000", bookingReason: "Cleaning", appointmentTypeId: 12 };
const booking = (args: Record<string, unknown>): ModelTurnResult => ({
  intent: "BOOK_APPOINTMENT", toolRequest: { name: "BOOK_APPOINTMENT", arguments: args }
});
const session = () => new CallSessionStore().create({ callSid: "CA-contract-test", officeCode: "TEST" });

test("rejects wrong field names without silently accepting aliases", () => {
  assert.match(bookingModelContractError(session(), booking({ ...validFields, dob: undefined, dateOfBirth: "04/01/2000" }))!, /dateOfBirth/);
  assert.match(bookingModelContractError(session(), booking({ ...validFields, reason: "Cleaning" }))!, /contract/);
});

test("requires an appointment type and validates its JSON type", () => {
  assert.match(bookingModelContractError(session(), booking({ ...validFields, appointmentTypeId: undefined }))!, /missing appointmentTypeId/);
  assert.match(bookingModelContractError(session(), booking({ ...validFields, appointmentTypeId: "12" }))!, /appointmentTypeId/);
  assert.equal(bookingModelContractError(session(), booking(validFields)), undefined);
});

test("accepts incremental collection and session-held fields without repeated questions", () => {
  const call = session();
  assert.equal(bookingModelContractError(call, { intent: "BOOK_APPOINTMENT", collectedFields: { firstName: "Nancy" } }), undefined);
  call.collectedFields = validFields;
  assert.equal(bookingModelContractError(call, booking({ datePreference: "09/09/2026" })), undefined);
  call.workflowState = { contractVersion: 1, workflow: "BOOK_APPOINTMENT", state: "NEEDS_PATIENT_IDENTITY", requiredField: "dob" };
  assert.match(bookingModelContractError(call, { intent: "BOOK_APPOINTMENT", reply: "What is your date of birth?" })!, /already known/);
});

test("does not apply booking field rules to another workflow or staff transfer", () => {
  const call = session();
  call.workflowState = { contractVersion: 1, workflow: "BOOK_APPOINTMENT", state: "COMPLETED" };
  assert.equal(bookingModelContractError(call, { intent: "CONFIRM_APPOINTMENT", collectedFields: { selectedAppointmentId: 3 } }), undefined);
  assert.equal(bookingModelContractError(call, { toolRequest: { name: "TRANSFER_TO_STAFF", arguments: {} } }), undefined);
});

test("asks the model to repair the logged malformed payload before returning it for execution", async () => {
  const call = session();
  const { client, requests } = mockModel([
    booking({ firstName: "Nancy", dateOfBirth: "04/01/2000", bookingReason: "Cleaning" }),
    booking(validFields)
  ]);
  const result = await client.nextTurn(call, "I was born April 1, 2000 and want a cleaning.");
  assert.deepEqual(result.toolRequest?.arguments, validFields);
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]), /Correct your previous JSON/);
  assert.match(JSON.stringify(requests[1]), /dateOfBirth/);
});

test("bounds invalid model repair to one retry", async () => {
  const { client, requests } = mockModel([booking({}), booking({})]);
  await assert.rejects(client.nextTurn(session(), "Book it"), BookingWorkflowError);
  assert.equal(requests.length, 2);
});

test("sends only repaired canonical arguments through the real booking adapter to Spring", async () => {
  const store = new CallSessionStore();
  const call = store.create({ callSid: "CA-contract-integration", officeCode: "TEST" });
  call.officeContext = {
    officeCode: "TEST", timezone: "America/New_York", providers: [{ providerName: "David Johnson" }],
    appointmentTypes: { RETURNING_PATIENT: [{ appointmentTypeId: 12, type: "Cleaning", duration: 60 }] }
  };
  const { client } = mockModel([
    booking({ firstName: "Nancy", dateOfBirth: "04/01/2000", bookingReason: "Cleaning" }),
    { ...booking(validFields), collectedFields: validFields },
    { intent: "BOOK_APPOINTMENT", reply: "What date would you prefer?" }
  ]);
  const sent: ToolRequest[] = [];
  const backend = new SpringBootClient();
  backend.executeTool = async (_callSid, _officeCode, tool) => {
    sent.push(tool);
    return { name: tool.name, ok: true, data: {
      workflow: "BOOK_APPOINTMENT", state: "NEEDS_DATE_PREFERENCE", requiredField: "datePreference"
    } };
  };
  const orchestrator = new AiReceptionistOrchestrator(store);
  Object.defineProperty(orchestrator, "modelClient", { value: client });
  Object.defineProperty(orchestrator, "toolExecutor", { value: new ToolExecutor(backend) });
  const outcome = await orchestrator.handleCallerText(call, "April 1, 2000. A cleaning, please.", { recordCallerTurn: false });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].arguments?.dob, "04/01/2000");
  assert.equal(sent[0].arguments?.appointmentTypeId, 12);
  assert.equal(sent[0].arguments?.providerName, "David Johnson");
  assert.equal(sent[0].arguments?.dateOfBirth, undefined);
  assert.equal(outcome.shouldTransferToStaff, false);
});

test("response-only mode keeps model wording but discards tools, approval and session updates", async () => {
  const call = session();
  call.workflowState = { contractVersion: 1, workflow: "BOOK_APPOINTMENT", state: "REQUIRES_CONFIRMATION",
    context: { providerName: "David Johnson", slotDate: "09/09/2026", slotTime: "02:00 PM" } };
  const { client, requests } = mockModel([{
    ...booking({ callerConfirmedBooking: true }),
    collectedFields: { callerConfirmedBooking: true }, shouldEndCall: true,
    reply: "Would you like me to reserve that time with David?"
  }]);
  const result = await client.bookingResponse(call, "AWAITING_CONFIRMATION");
  assert.deepEqual(result, { reply: "Would you like me to reserve that time with David?", intent: "BOOK_APPOINTMENT", shouldEndCall: false });
  assert.equal(call.collectedFields.callerConfirmedBooking, undefined);
  const request = requests[0] as { messages: Array<{ content: string }> };
  const context = JSON.parse(request.messages[1].content).responseContext;
  assert.equal(context.requiresNewCallerApproval, true);
  assert.equal(context.selectedAppointment.providerName, "David Johnson");
  assert.equal(context.toolExecutionAllowed, false);
});

test("response-only handoff wording cannot turn into a booking request", async () => {
  const { client } = mockModel([{ ...booking(validFields), reply: "Let me connect you with our team." }]);
  const result = await client.bookingResponse(session(), "HANDOFF");
  assert.equal(result.toolRequest, undefined);
  assert.equal(result.intent, "TRANSFER_TO_STAFF");
  assert.equal(result.shouldEndCall, true);
});

test("follow-up execution strips model approval while preserving its wording", () => {
  const result = prepareBookingFollowup(session(), {
    ...booking({ ...validFields, callerConfirmedBooking: true }),
    collectedFields: { callerConfirmedBooking: true }, reply: "Checking that date."
  }, 0);
  assert.equal(result.reply, "Checking that date.");
  assert.equal(result.toolRequest?.arguments.callerConfirmedBooking, false);
  assert.equal(result.collectedFields?.callerConfirmedBooking, false);
});

function mockModel(results: ModelTurnResult[]) {
  const client = new ModelClient();
  const requests: unknown[] = [];
  Object.defineProperty(client, "client", { value: { chat: { completions: {
    async create(request: unknown) {
      requests.push(request);
      assert.ok(results.length, "unexpected additional model request");
      return { choices: [{ message: { content: JSON.stringify(results.shift()) } }] };
    }
  } } } });
  return { client, requests };
}
