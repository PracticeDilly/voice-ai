import assert from "node:assert/strict";
import test from "node:test";
import { CallSession, CallSessionStore } from "../../src/calls/callSession.js";
import { AiReceptionistOrchestrator } from "../../src/conversation/aiReceptionistOrchestrator.js";
import { ModelTurnResult } from "../../src/conversation/modelClient.js";
import { ToolRequest, ToolResult } from "../../src/backend/springBootClient.js";
import { BookingWorkflowError } from "../../src/workflows/bookAppointment/bookingModelContract.js";

test("asks once whether a booking caller is new or returning and honors the new choice", async () => {
  const sessions = new CallSessionStore();
  const session = sessions.create({ callSid: "CA-patient-choice", officeCode: "TEST", fromNumber: "+15551234567" });
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  let modelCalls = 0;
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn(_session: CallSession, callerText: string) {
      modelCalls += 1;
      if (callerText !== "I'd like to book a cleaning") {
        return {
          intent: "BOOK_APPOINTMENT",
          callerAction: { patientTypeChoice: "NEW_PATIENT" }
        };
      }
      return {
        intent: "BOOK_APPOINTMENT",
        collectedFields: { bookingReason: "cleaning" },
        toolRequest: { name: "BOOK_APPOINTMENT", arguments: {} }
      };
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute() { throw new Error("must not book before the patient chooses a path"); }
  } });

  const first = await orchestrator.handleCallerText(session, "I'd like to book a cleaning", { recordCallerTurn: false });
  assert.match(first.reply, /new to our office or have they visited before/i);
  assert.equal(session.awaitingBookingPatientChoice, true);
  assert.equal(session.collectedFields.bookingReason, "cleaning");
  const second = await orchestrator.handleCallerText(session, "I'm a new patient", { recordCallerTurn: false });
  assert.match(second.reply, /full name/i);
  assert.equal(session.newPatientBookingCandidate, true);
  assert.equal(session.bookingPatientChoice, "NEW_PATIENT");
  assert.equal(session.workflowState?.state, "NEEDS_NEW_PATIENT_DATA");
  assert.equal(modelCalls, 2);
});

test("a returning booking caller is asked to spell their name without being classified from caller ID", async () => {
  const sessions = new CallSessionStore();
  const session = sessions.create({ callSid: "CA-returning-choice", officeCode: "TEST", fromNumber: "+15551234567" });
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn(_session: CallSession, callerText: string) {
      return callerText === "I need an appointment"
        ? { intent: "BOOK_APPOINTMENT", reply: "What is your name?" }
        : { intent: "BOOK_APPOINTMENT", callerAction: { patientTypeChoice: "RETURNING_PATIENT" } };
    }
  } });
  await orchestrator.handleCallerText(session, "I need an appointment", { recordCallerTurn: false });
  const choice = await orchestrator.handleCallerText(session, "I'm a returning patient", { recordCallerTurn: false });
  assert.match(choice.reply, /first name/i);
  assert.doesNotMatch(choice.reply, /spell/i);
  assert.equal(session.bookingPatientChoice, "RETURNING_PATIENT");
  assert.equal(session.newPatientBookingCandidate, undefined);
});

test("keeps asking when the model classifies the patient-type answer as ambiguous or contradictory", async () => {
  const sessions = new CallSessionStore();
  const session = sessions.create({ callSid: "CA-patient-choice-unclear", officeCode: "TEST", fromNumber: "+15551234567" });
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  let bookingExecutions = 0;
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn(_session: CallSession, callerText: string) {
      if (callerText === "I want to book a cleaning") {
        return { intent: "BOOK_APPOINTMENT", toolRequest: { name: "BOOK_APPOINTMENT", arguments: {} } };
      }
      return { intent: "BOOK_APPOINTMENT", callerAction: { patientTypeChoice: null } };
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute() {
      bookingExecutions += 1;
      throw new Error("booking must wait until patient type is clear");
    }
  } });

  await orchestrator.handleCallerText(session, "I want to book a cleaning", { recordCallerTurn: false });
  const answer = await orchestrator.handleCallerText(session, "I've been to a dentist before, but I'm not sure what you mean", { recordCallerTurn: false });
  const contradiction = await orchestrator.handleCallerText(session, "I'm new, but I've been to this office before", { recordCallerTurn: false });

  assert.match(answer.reply, /new to our office or have they visited before/i);
  assert.match(contradiction.reply, /new to our office or have they visited before/i);
  assert.equal(session.awaitingBookingPatientChoice, true);
  assert.equal(session.bookingPatientChoice, undefined);
  assert.equal(bookingExecutions, 0);
});

test("checks the next date window when the model recognizes a natural acceptance of the offer", async () => {
  const { orchestrator, session, executed } = bookingHarness([
    { intent: "BOOK_APPOINTMENT", reply: "I found more times. Which works for you?" }
  ], ["SELECT_SLOT"]);
  session.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "NEEDS_SCHEDULING_PREFERENCE"
  };
  session.lastBookingSearchRange = { fromDate: "09/30/2026", toDate: "10/01/2026" };
  session.transcript.push({
    speaker: "assistant",
    text: "Would you like me to check the next available appointment?",
    at: "2026-09-30T11:30:07.000Z"
  });
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return {
        callerAction: {
          speechAct: "AUTHORIZATION",
          workflowIntent: "NEXT_APPOINTMENT",
          requestedAction: "LOOKUP_APPOINTMENTS"
        }
      };
    },
    async continueWithToolResult() {
      return { intent: "BOOK_APPOINTMENT", reply: "I found more times. Which works for you?" };
    }
  } });

  const outcome = await orchestrator.handleCallerText(session, "The earliest one would be great, please.", { recordCallerTurn: false });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].arguments.fromDate, "10/02/2026");
  assert.equal(executed[0].arguments.toDate, "10/09/2026");
  assert.match(outcome.reply, /Which works for you/i);
});

test("does not search the next date window for an unclear response to the offer", async () => {
  const { orchestrator, session, executed } = bookingHarness([], []);
  session.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "NEEDS_SCHEDULING_PREFERENCE"
  };
  session.lastBookingSearchRange = { fromDate: "09/30/2026", toDate: "10/01/2026" };
  session.transcript.push({
    speaker: "assistant",
    text: "Would you like me to check the next available appointment?",
    at: "2026-09-30T11:30:07.000Z"
  });
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return { callerAction: { speechAct: "QUESTION", workflowIntent: "NEXT_APPOINTMENT" } };
    }
  } });

  await orchestrator.handleCallerText(session, "What dates would that include?", { recordCallerTurn: false });

  assert.equal(executed.length, 0);
});

test("does not end or transfer a caller who only questions a failed lookup", async () => {
  const sessions = new CallSessionStore();
  const callSession = sessions.create({ callSid: "CA-lookup-question", officeCode: "TEST" });
  callSession.currentIntent = "next_appointment";
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return { intent: "next_appointment", reply: "I will transfer you now.", shouldEndCall: true };
    }
  } });
  const outcome = await orchestrator.handleCallerText(callSession, "Why couldn't you match it?", { recordCallerTurn: false });
  assert.equal(outcome.shouldEndSession, false);
  assert.equal(outcome.shouldTransferToStaff, false);
});

test("ends when the receptionist gives a terminal goodbye and the model marks the turn complete", async () => {
  const sessions = new CallSessionStore();
  const session = sessions.create({ callSid: "CA-terminal-goodbye", officeCode: "TEST" });
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return {
        intent: "BOOK_APPOINTMENT",
        reply: "If you need anything else, please call us. Have a great day!",
        assistantAction: "END_CALL"
      };
    }
  } });

  const outcome = await orchestrator.handleCallerText(session, "That's okay", { recordCallerTurn: false });

  assert.equal(outcome.shouldEndSession, true);
  assert.equal(outcome.shouldTransferToStaff, false);
});

test("ends after the caller declines further help following the receptionist's closing question", async () => {
  const sessions = new CallSessionStore();
  const session = sessions.create({ callSid: "CA-closing-no-thanks", officeCode: "TEST" });
  session.transcript.push({
    speaker: "assistant",
    text: "Is there anything else I can help you with?",
    at: "2026-09-30T00:00:00.000Z"
  });
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() { return { callerAction: { speechAct: "GOODBYE", requestedAction: "NONE" } }; }
  } });

  const outcome = await orchestrator.handleCallerText(session, "No. Thank you.", { recordCallerTurn: false });

  assert.equal(outcome.shouldEndSession, true);
  assert.equal(outcome.shouldTransferToStaff, false);
  assert.match(outcome.reply, /thank you for calling/i);
});

test("executes a booking tool returned by the follow-up model instead of leaving the caller waiting", async () => {
  const { orchestrator, session, executed } = bookingHarness([
    { intent: "BOOK_APPOINTMENT", toolRequest: { name: "BOOK_APPOINTMENT", arguments: { dob: "04/01/2000" } } },
    { intent: "BOOK_APPOINTMENT", reply: "Would 2 PM work?" }
  ], ["NEEDS_PATIENT_IDENTITY", "SELECT_SLOT"]);
  const outcome = await orchestrator.handleCallerText(session, "Book a cleaning", { recordCallerTurn: false });
  assert.equal(executed.length, 2);
  assert.equal(executed[1].arguments?.dob, "04/01/2000");
  assert.equal(executed[1].arguments?.callerConfirmedBooking, false);
  assert.equal(outcome.reply, "Would 2 PM work?");
  assert.equal(outcome.shouldTransferToStaff, false);
});

test("uses model wording at confirmation without another executable model turn", async () => {
  const { orchestrator, session, executed } = bookingHarness([], ["REQUIRES_CONFIRMATION"]);
  const outcome = await orchestrator.handleCallerText(session, "2 PM works", { recordCallerTurn: false });
  assert.equal(executed.length, 1);
  assert.equal(outcome.reply, "Shall I reserve that appointment for you?");
  assert.notEqual(session.collectedFields.callerConfirmedBooking, true);
});

test("does not execute another booking after completion", async () => {
  const { orchestrator, session, executed } = bookingHarness([
    { intent: "BOOK_APPOINTMENT", reply: "Your appointment is booked.", toolRequest: { name: "BOOK_APPOINTMENT", arguments: {} } }
  ], ["COMPLETED"]);
  await orchestrator.handleCallerText(session, "Yes", { recordCallerTurn: false });
  assert.equal(executed.length, 1);
});

test("books once on the next caller approval without asking for confirmation again", async () => {
  const { orchestrator, session, executed } = bookingHarness([], ["REQUIRES_CONFIRMATION", "COMPLETED"]);
  let callerTurn = 0;
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      callerTurn += 1;
      return { intent: "BOOK_APPOINTMENT", toolRequest: {
        name: "BOOK_APPOINTMENT", arguments: { callerConfirmedBooking: callerTurn === 2 }
      } };
    },
    async continueWithToolResult() {
      return { intent: "BOOK_APPOINTMENT", reply: "Your appointment is booked." };
    },
    async bookingResponse() {
      return { intent: "BOOK_APPOINTMENT", reply: "Shall I reserve that appointment for you?", shouldEndCall: false };
    }
  } });
  const selection = await orchestrator.handleCallerText(session, "2 PM", { recordCallerTurn: false });
  assert.equal(selection.reply, "Shall I reserve that appointment for you?");
  const confirmation = await orchestrator.handleCallerText(session, "Yes, please", { recordCallerTurn: false });
  assert.equal(executed.length, 2);
  assert.equal(executed[1].arguments?.callerConfirmedBooking, true);
  assert.equal(confirmation.reply, "Your appointment is booked.");
  assert.equal(confirmation.shouldTransferToStaff, false);
});

test("bounds repeated follow-up tool requests", async () => {
  const followup = { intent: "BOOK_APPOINTMENT", toolRequest: { name: "BOOK_APPOINTMENT", arguments: {} } };
  const { orchestrator, session, executed } = bookingHarness([followup, followup, followup], ["NEEDS_PATIENT_IDENTITY"]);
  const outcome = await orchestrator.handleCallerText(session, "Book it", { recordCallerTurn: false });
  assert.equal(executed.length, 3);
  assert.equal(outcome.shouldTransferToStaff, false);
  assert.equal(session.pendingActions.TRANSFER_TO_STAFF?.status, "AWAITING_CALLER_CONFIRMATION");
});

test("asks for a new date instead of repeating a no-opening search", async () => {
  const { orchestrator, session, executed } = bookingHarness([
    { intent: "BOOK_APPOINTMENT", toolRequest: { name: "BOOK_APPOINTMENT", arguments: {} } }
  ], ["NEEDS_SCHEDULING_PREFERENCE"]);
  session.collectedFields.datePreference = "09/16/2026";

  const outcome = await orchestrator.handleCallerText(session, "Please check it.", { recordCallerTurn: false });

  assert.equal(executed.length, 1);
  assert.equal(outcome.shouldTransferToStaff, false);
  assert.match(outcome.reply, /specific date|other date/i);
});

test("contract repair exhaustion hands off without the booking policy issuing another tool", async () => {
  const { orchestrator, session, executed } = bookingHarness([], []);
  session.workflowState = { contractVersion: 1, workflow: "BOOK_APPOINTMENT", state: "NEEDS_PATIENT_IDENTITY" };
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() { throw new BookingWorkflowError("invalid model output"); },
    async bookingResponse() { return { reply: "Our team can help you finish arranging this visit." }; }
  } });
  const outcome = await orchestrator.handleCallerText(session, "Book it", { recordCallerTurn: false });
  assert.equal(executed.length, 0);
  assert.equal(outcome.shouldTransferToStaff, false);
  assert.equal(session.pendingActions.TRANSFER_TO_STAFF?.status, "AWAITING_CALLER_CONFIRMATION");
});

test("does not transfer when identity policy suppresses an inferred transfer", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-identity-transfer", officeCode: "TEST" });
  session.currentIntent = "BOOK_APPOINTMENT";
  session.collectedFields.firstName = "Nancy";
  session.workflowState = {
    contractVersion: 1,
    workflow: "PATIENT_VERIFICATION",
    state: "FAILED",
    allowedActions: ["VERIFY_PATIENT", "TRANSFER_TO_STAFF"],
    failureReason: "FIRST_NAME_NO_MATCH",
    context: {
      patientVerified: false,
      canDisclosePatientData: false
    }
  };
  session.pendingActions.VERIFY_PATIENT_IDENTITY = {
    status: "NEEDS_NAME_SPELLING",
    value: "Nancy",
    createdAt: "2026-09-11T00:00:00.000Z"
  };

  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return {
        intent: "BOOK_APPOINTMENT",
        collectedFields: { firstName: "Nancy" },
        toolRequest: { name: "TRANSFER_TO_STAFF", arguments: {} }
      };
    }
  } });

  const outcome = await orchestrator.handleCallerText(session, "Yes", { recordCallerTurn: false });

  assert.equal(outcome.shouldTransferToStaff, false);
  assert.match(outcome.reply, /spell your first name/i);
});

test("uses explicit model authorization to leave failed verification and enter new-patient booking", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-new-patient-consent", officeCode: "TEST", fromNumber: "+15551234567" });
  session.currentIntent = "BOOK_APPOINTMENT";
  session.collectedFields = { firstName: "Mary", dob: "01/01/2001", bookingReason: "Cleaning" };
  session.workflowState = {
    contractVersion: 1,
    workflow: "PATIENT_VERIFICATION",
    state: "FAILED",
    allowedActions: ["VERIFY_PATIENT", "TRANSFER_TO_STAFF"],
    failureReason: "DOB_NO_MATCH",
    context: { patientVerified: false, canDisclosePatientData: false }
  };
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return {
        intent: "BOOK_APPOINTMENT",
        collectedFields: { bookingReason: "Cleaning" },
        callerAction: {
          speechAct: "AUTHORIZATION",
          workflowIntent: "BOOK_APPOINTMENT",
          requestedAction: "BOOK_APPOINTMENT",
          authorization: { stateChangingAction: "CONTINUE_AS_NEW_PATIENT", isExplicit: true }
        },
        reply: "Okay."
      };
    }
  } });

  const outcome = await orchestrator.handleCallerText(session, "Let's start fresh with your office.", { recordCallerTurn: false });

  assert.equal(outcome.shouldTransferToStaff, false);
  assert.equal(session.newPatientBookingCandidate, true);
  assert.equal(session.workflowState?.workflow, "BOOK_APPOINTMENT");
  assert.equal(session.workflowState?.state, "NEEDS_NEW_PATIENT_DATA");
});

test("does not switch to new-patient booking from affirmative wording without model authorization", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-new-patient-no-authorization", officeCode: "TEST", fromNumber: "+15551234567" });
  session.currentIntent = "BOOK_APPOINTMENT";
  session.collectedFields = { firstName: "Mary", dob: "01/01/2001", bookingReason: "Cleaning" };
  session.workflowState = {
    contractVersion: 1,
    workflow: "PATIENT_VERIFICATION",
    state: "NEEDS_NEW_PATIENT_CONFIRMATION",
    allowedActions: ["BOOK_APPOINTMENT", "TRANSFER_TO_STAFF"],
    failureReason: "NO_EXISTING_PATIENT_RECORD",
    context: { patientVerified: false, canDisclosePatientData: false }
  };
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return { intent: "BOOK_APPOINTMENT", callerAction: { speechAct: "ACKNOWLEDGEMENT" }, reply: "Okay." };
    }
  } });

  await orchestrator.handleCallerText(session, "Yeah, let's continue as a new patient.", { recordCallerTurn: false });

  assert.equal(session.newPatientBookingCandidate, undefined);
  assert.equal(session.workflowState?.workflow, "PATIENT_VERIFICATION");
  assert.equal(session.workflowState?.state, "NEEDS_NEW_PATIENT_CONFIRMATION");
});

test("ends the call from a structured caller goodbye", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-end-call", officeCode: "TEST" });
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return { callerAction: { speechAct: "GOODBYE", requestedAction: "NONE" } };
    }
  } });

  const outcome = await orchestrator.handleCallerText(session, "No. Thank you. Thanks a lot.", { recordCallerTurn: false });

  assert.equal(outcome.shouldEndSession, true);
  assert.equal(outcome.shouldTransferToStaff, false);
  assert.match(outcome.reply, /thank you for calling/i);
});

test("transfers immediately when the caller explicitly requests staff", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-direct-staff", officeCode: "TEST" });
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      throw new Error("an explicit staff request should not need model confirmation");
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute() {
      return { name: "TRANSFER_TO_STAFF", ok: true };
    }
  } });

  const outcome = await orchestrator.handleCallerText(
    session,
    "Hi, Lisa. Could you please transfer this call to the office staff?",
    { recordCallerTurn: false }
  );

  assert.equal(outcome.shouldEndSession, true);
  assert.equal(outcome.shouldTransferToStaff, true);
  assert.match(outcome.reply, /office staff/i);
  assert.equal(outcome.handoffData?.reasonCode, "live-agent-handoff");
  assert.equal(session.pendingActions.TRANSFER_TO_STAFF, undefined);
});

test("transfers after a model offered staff and the caller says Yeah. Sure.", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-insurance-transfer", officeCode: "TEST" });
  let modelTurns = 0;
  let transfers = 0;
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn(_session: CallSession, callerText: string) {
      modelTurns += 1;
      if (callerText === "Yeah. Sure.") {
        return { callerAction: {
          speechAct: "AUTHORIZATION",
          workflowIntent: "TRANSFER_TO_STAFF",
          requestedAction: "TRANSFER_TO_STAFF",
          authorization: { stateChangingAction: "TRANSFER_TO_STAFF", isExplicit: true }
        } };
      }
      return {
        intent: "insurance_questions",
        assistantAction: "OFFER_STAFF_TRANSFER",
        reply: "I don't have the specific list of insurance plans supported by our office. Would you like me to connect you with a staff member who can provide that information?"
      };
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute() {
      transfers += 1;
      return { name: "TRANSFER_TO_STAFF", ok: true };
    }
  } });

  const offer = await orchestrator.handleCallerText(session, "What insurances are supported?", { recordCallerTurn: false });
  assert.equal(offer.shouldTransferToStaff, false);
  assert.equal(session.pendingActions.TRANSFER_TO_STAFF?.status, "AWAITING_CALLER_CONFIRMATION");

  const outcome = await orchestrator.handleCallerText(session, "Yeah. Sure.", { recordCallerTurn: false });
  assert.equal(modelTurns, 2);
  assert.equal(transfers, 1);
  assert.equal(outcome.shouldTransferToStaff, true);
  assert.equal(outcome.shouldEndSession, true);
  assert.equal(session.pendingActions.TRANSFER_TO_STAFF, undefined);
});

test("treats willingness to speak with the office as acceptance of a pending offer", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-office-transfer-acceptance", officeCode: "TEST" });
  let transfers = 0;
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return { callerAction: {
        speechAct: "AUTHORIZATION",
        workflowIntent: "TRANSFER_TO_STAFF",
        requestedAction: "TRANSFER_TO_STAFF",
        authorization: { stateChangingAction: "TRANSFER_TO_STAFF", isExplicit: true }
      } };
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute() {
      transfers += 1;
      return { name: "TRANSFER_TO_STAFF", ok: true };
    }
  } });
  session.pendingActions.TRANSFER_TO_STAFF = {
    status: "AWAITING_CALLER_CONFIRMATION",
    reason: "assistant-offered-transfer",
    createdAt: new Date().toISOString()
  };

  const outcome = await orchestrator.handleCallerText(session, "Okay, I'll talk to the office.", { recordCallerTurn: false });

  assert.equal(transfers, 1);
  assert.equal(outcome.shouldTransferToStaff, true);
  assert.equal(outcome.shouldEndSession, true);
  assert.equal(session.pendingActions.TRANSFER_TO_STAFF, undefined);
});

test("tracks an offer to speak with someone at the office as a pending transfer", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-speak-office-offer", officeCode: "TEST" });
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return {
        reply: "A colleague can help with more options.",
        assistantAction: "OFFER_STAFF_TRANSFER"
      };
    }
  } });

  await orchestrator.handleCallerText(session, "Could I book an appointment?", { recordCallerTurn: false });

  assert.equal(session.pendingActions.TRANSFER_TO_STAFF?.status, "AWAITING_CALLER_CONFIRMATION");
});

test("clears a model offered transfer when the caller declines", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-insurance-no-transfer", officeCode: "TEST" });
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn(_session: CallSession, callerText: string) {
      if (callerText === "No, thanks.") {
        return { callerAction: { speechAct: "DECLINE", workflowIntent: "TRANSFER_TO_STAFF" } };
      }
      return {
        intent: "insurance_questions",
        assistantAction: "OFFER_STAFF_TRANSFER",
        reply: "Would you like me to connect you with our office staff?"
      };
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute() {
      throw new Error("a declined transfer must not execute");
    }
  } });

  await orchestrator.handleCallerText(session, "Can you help with insurance?", { recordCallerTurn: false });
  const outcome = await orchestrator.handleCallerText(session, "No, thanks.", { recordCallerTurn: false });
  assert.match(outcome.reply, /won't transfer/i);
  assert.equal(outcome.shouldTransferToStaff, false);
  assert.equal(session.pendingActions.TRANSFER_TO_STAFF, undefined);
});

test("keeps the transfer offer pending when the caller's answer is unclear", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-insurance-unclear-transfer", officeCode: "TEST" });
  let transfers = 0;
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn(_session: CallSession, callerText: string) {
      if (callerText === "Can you help with insurance?") {
        return {
          assistantAction: "OFFER_STAFF_TRANSFER",
          reply: "Would you like me to connect you with our office staff?"
        };
      }
      return { callerAction: { speechAct: "UNKNOWN", workflowIntent: "TRANSFER_TO_STAFF" } };
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute() {
      transfers += 1;
      return { name: "TRANSFER_TO_STAFF", ok: true };
    }
  } });

  await orchestrator.handleCallerText(session, "Can you help with insurance?", { recordCallerTurn: false });
  const outcome = await orchestrator.handleCallerText(session, "I'm not sure", { recordCallerTurn: false });

  assert.match(outcome.reply, /please say yes or no/i);
  assert.equal(transfers, 0);
  assert.equal(session.pendingActions.TRANSFER_TO_STAFF?.status, "AWAITING_CALLER_CONFIRMATION");
});

test("asks for the missing identity field instead of recursing verification tools", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-identity-loop", officeCode: "TEST" });
  session.currentIntent = "BOOK_APPOINTMENT";
  session.workflowState = {
    contractVersion: 1,
    workflow: "PATIENT_VERIFICATION",
    state: "NEEDS_INPUT",
    requiredField: "firstName",
    allowedActions: ["VERIFY_PATIENT"]
  };

  const executed: ToolRequest[] = [];
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return { intent: "BOOK_APPOINTMENT", toolRequest: { name: "VERIFY_PATIENT", arguments: {} } };
    },
    async continueWithToolResult() {
      return {
        intent: "BOOK_APPOINTMENT",
        toolRequest: { name: "VERIFY_PATIENT", arguments: {} }
      };
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute(_session: CallSession, tool: ToolRequest) {
      executed.push(tool);
      return {
        name: tool.name,
        ok: true,
        workflowState: {
          contractVersion: 1,
          workflow: "PATIENT_VERIFICATION",
          state: "NEEDS_INPUT",
          requiredField: "firstName",
          allowedActions: ["VERIFY_PATIENT"]
        }
      };
    }
  } });

  const outcome = await orchestrator.handleCallerText(session, "Book an appointment", { recordCallerTurn: false });

  assert.equal(executed.length, 0);
  assert.match(outcome.reply, /first name/i);
  assert.equal(outcome.shouldTransferToStaff, false);
});

test("requires confirmation before executing a model-requested staff transfer", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-transfer-terminal", officeCode: "TEST" });
  const executed: ToolRequest[] = [];

  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn(_session: CallSession, callerText: string) {
      if (callerText === "Yes.") {
        return { callerAction: {
          speechAct: "AUTHORIZATION",
          workflowIntent: "TRANSFER_TO_STAFF",
          requestedAction: "TRANSFER_TO_STAFF",
          authorization: { stateChangingAction: "TRANSFER_TO_STAFF", isExplicit: true }
        } };
      }
      return {
        intent: "TRANSFER_TO_STAFF",
        reply: "I will connect you with the office staff now.",
        toolRequest: { name: "TRANSFER_TO_STAFF", arguments: {} }
      };
    },
    async continueWithToolResult() {
      throw new Error("a terminal staff transfer must not request a follow-up model turn");
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute(_session: CallSession, tool: ToolRequest) {
      executed.push(tool);
      return { name: tool.name, ok: true };
    }
  } });

  const offer = await orchestrator.handleCallerText(session, "I need help from the office.", { recordCallerTurn: false });

  assert.equal(executed.length, 0);
  assert.equal(offer.shouldEndSession, false);
  assert.equal(offer.shouldTransferToStaff, false);
  assert.match(offer.reply, /would you like me to transfer/i);

  const outcome = await orchestrator.handleCallerText(session, "Yes.", { recordCallerTurn: false });
  assert.equal(executed.length, 1);
  assert.equal(outcome.shouldEndSession, true);
  assert.equal(outcome.shouldTransferToStaff, true);
  assert.equal(outcome.reply, "I will connect you with our office staff now.");
});

test("treats a caller's time-slot selection as a selection, not a repeat-times request", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-slot-selection", officeCode: "TEST" });
  session.currentIntent = "BOOK_APPOINTMENT";
  session.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "SELECT_SLOT",
    requiredField: "slotDate",
    allowedActions: ["BOOK_APPOINTMENT"],
    context: { slots: [{ slotDate: "09/29/2026", slotTime: "12:30 PM" }] }
  };
  const executed: ToolRequest[] = [];

  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return {
        intent: "BOOK_APPOINTMENT",
        toolRequest: {
          name: "BOOK_APPOINTMENT",
          arguments: { slotDate: "09/29/2026", slotTime: "12:30 PM" }
        }
      };
    },
    async continueWithToolResult() {
      throw new Error("the confirmation response should be generated by the booking boundary");
    },
    async bookingResponse(_session: CallSession, purpose: string) {
      return {
        intent: "BOOK_APPOINTMENT",
        reply: purpose === "REPEAT_SLOTS" ? "Repeated slots." : "May I go ahead and book that slot?",
        shouldEndCall: false
      };
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute(_session: CallSession, tool: ToolRequest) {
      executed.push(tool);
      return {
        name: tool.name,
        ok: true,
        workflowState: {
          contractVersion: 1,
          workflow: "BOOK_APPOINTMENT",
          state: "REQUIRES_CONFIRMATION",
          requiredField: "callerConfirmedBooking",
          allowedActions: ["BOOK_APPOINTMENT"]
        }
      };
    }
  } });

  const outcome = await orchestrator.handleCallerText(
    session,
    "The time slot at 12:30 appears to be good to me."
  );

  assert.equal(executed.length, 1);
  assert.match(outcome.reply, /go ahead and book/i);
});

test("books the selected slot in one caller turn after an explicit appointment request", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-book-selected-slot", officeCode: "TEST" });
  session.currentIntent = "BOOK_APPOINTMENT";
  session.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "SELECT_SLOT",
    context: { slots: [{ slotDate: "10/02/2026", slotTime: "04:30 PM" }] }
  };
  await orchestrator.recordCallerTurn(session, "I wanted to book an appointment.");
  const executed: ToolRequest[] = [];
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return {
        intent: "BOOK_APPOINTMENT",
        callerAction: {
          speechAct: "AUTHORIZATION",
          workflowIntent: "BOOK_APPOINTMENT",
          requestedAction: "BOOK_APPOINTMENT",
          authorization: {
            stateChangingAction: "BOOK_APPOINTMENT",
            isExplicit: true,
            selectedAppointmentReference: { slotDate: "10/02/2026", slotTime: "04:30 PM" }
          }
        },
        reply: "Let me confirm your contact information again."
      };
    },
    async bookingResponse() {
      throw new Error("slot selection already authorized booking");
    },
    async continueWithToolResult() {
      throw new Error("completed booking should use the backend result");
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute(_session: CallSession, tool: ToolRequest) {
      executed.push(tool);
      return {
        name: tool.name,
        ok: true,
        workflowState: {
          contractVersion: 1,
          workflow: "BOOK_APPOINTMENT",
          state: executed.length === 1 ? "REQUIRES_CONFIRMATION" : "COMPLETED",
          context: { slotDate: "10/02/2026", slotTime: "04:30 PM" }
        }
      };
    }
  } });

  const outcome = await orchestrator.handleCallerText(session, "Okay. So the 04:30PM sounds good to me.");

  assert.equal(executed.length, 2);
  assert.equal(executed[1].arguments.callerConfirmedBooking, true);
  assert.match(outcome.reply, /appointment is booked for 10\/02\/2026 at 04:30 PM/i);
  assert.equal(outcome.shouldTransferToStaff, false);
});

test("does not auto-book a different slot than the one the caller named", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({ callSid: "CA-slot-mismatch", officeCode: "TEST" });
  session.currentIntent = "BOOK_APPOINTMENT";
  session.workflowState = {
    contractVersion: 1,
    workflow: "BOOK_APPOINTMENT",
    state: "SELECT_SLOT",
    context: { slots: [
      { slotDate: "10/02/2026", slotTime: "04:30 PM" },
      { slotDate: "10/02/2026", slotTime: "05:00 PM" }
    ] }
  };
  await orchestrator.recordCallerTurn(session, "I want to book an appointment.");
  let executions = 0;
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return {
        intent: "BOOK_APPOINTMENT",
        toolRequest: { name: "BOOK_APPOINTMENT", arguments: {
          slotDate: "10/02/2026", slotTime: "05:00 PM", callerConfirmedBooking: true
        } }
      };
    },
    async bookingResponse() {
      return { intent: "BOOK_APPOINTMENT", reply: "Please confirm the selected time." };
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute() {
      executions += 1;
      return { name: "BOOK_APPOINTMENT", ok: true, workflowState: {
        contractVersion: 1,
        workflow: "BOOK_APPOINTMENT",
        state: "REQUIRES_CONFIRMATION",
        context: { slotDate: "10/02/2026", slotTime: "05:00 PM" }
      } };
    }
  } });

  const outcome = await orchestrator.handleCallerText(session, "4:30 sounds good to me.");
  assert.equal(executions, 1);
  assert.match(outcome.reply, /confirm the selected time/i);
});

function bookingHarness(followups: ModelTurnResult[], states: string[]) {
  const sessions = new CallSessionStore();
  const session = sessions.create({ callSid: "CA-booking-followup", officeCode: "TEST" });
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const executed: ToolRequest[] = [];
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() { return { intent: "BOOK_APPOINTMENT", toolRequest: { name: "BOOK_APPOINTMENT", arguments: {} } }; },
    async continueWithToolResult() {
      assert.ok(followups.length, "unexpected follow-up model call");
      return followups.shift();
    },
    async bookingResponse(_session: CallSession, purpose: string) {
      return { intent: purpose === "HANDOFF" ? "TRANSFER_TO_STAFF" : "BOOK_APPOINTMENT",
        reply: purpose === "HANDOFF"
          ? "Our team can help with this visit."
          : purpose === "SCHEDULING_PREFERENCE"
            ? "What other date would you like me to check?"
            : "Shall I reserve that appointment for you?",
        shouldEndCall: purpose === "HANDOFF" };
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute(_session: CallSession, tool: ToolRequest) {
      executed.push(tool);
      return { name: tool.name, ok: true, workflowState: {
        contractVersion: 1, workflow: "BOOK_APPOINTMENT", state: states[Math.min(executed.length - 1, states.length - 1)]
      } };
    }
  } });
  return { orchestrator, session, executed };
}

test("returns a deterministic confirmation prompt when a selected appointment still needs caller approval", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = buildSession(sessions);

  const executedTools: ToolRequest[] = [];

  (orchestrator as unknown as {
    springBootClient: {
      saveTranscriptTurn(input: unknown): Promise<void>;
    };
    modelClient: {
      nextTurn(session: CallSession, callerText: string): Promise<ModelTurnResult>;
      continueWithToolResult(session: CallSession, toolResult: unknown): Promise<ModelTurnResult>;
      continueWithPolicyInstruction(session: CallSession, instruction: string, boundaryContext?: unknown): Promise<ModelTurnResult>;
    };
    toolExecutor: {
      execute(session: CallSession, tool: ToolRequest): Promise<ToolResult>;
    };
  }).springBootClient = {
    async saveTranscriptTurn() {}
  };

  (orchestrator as unknown as {
    modelClient: {
      nextTurn(session: CallSession, callerText: string): Promise<ModelTurnResult>;
      continueWithToolResult(session: CallSession, toolResult: unknown): Promise<ModelTurnResult>;
      continueWithPolicyInstruction(session: CallSession, instruction: string, boundaryContext?: unknown): Promise<ModelTurnResult>;
    };
  }).modelClient = {
    async nextTurn() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        reply: "I can help with that."
      };
    },
    async continueWithToolResult() {
      throw new Error("tool result follow-up should not be needed before caller approval");
    },
    async continueWithPolicyInstruction() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        reply: "To confirm your appointment on August 27, 2026, at 8:20 AM with Dr. David Johnson, should I go ahead and confirm it for you?"
      };
    }
  };

  (orchestrator as unknown as {
    toolExecutor: {
      execute(session: CallSession, tool: ToolRequest): Promise<ToolResult>;
    };
  }).toolExecutor = {
    async execute(_session, tool) {
      executedTools.push(tool);
      return {
        name: tool.name,
        ok: true
      };
    }
  };

  const outcome = await orchestrator.handleCallerText(session, "Please confirm it.");

  assert.equal(executedTools.length, 0);
  assert.equal(session.pendingActions.CONFIRM_APPOINTMENT?.appointmentId, 503);
  assert.match(outcome.reply, /should i go ahead and confirm it/i);
  assert.match(outcome.reply, /August 27, 2026/i);
});

test("requires workflow confirmation prompt before executing a newly selected appointment", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({
    callSid: "CA-direct-confirm",
    officeCode: "MSHNN"
  });
  session.currentIntent = "CONFIRM_APPOINTMENT";

  const executedTools: ToolRequest[] = [];

  (orchestrator as unknown as {
    springBootClient: {
      saveTranscriptTurn(input: unknown): Promise<void>;
    };
    modelClient: {
      nextTurn(session: CallSession, callerText: string): Promise<ModelTurnResult>;
      continueWithToolResult(session: CallSession, toolResult: unknown): Promise<ModelTurnResult>;
      continueWithPolicyInstruction(session: CallSession, instruction: string, boundaryContext?: unknown): Promise<ModelTurnResult>;
    };
    toolExecutor: {
      execute(session: CallSession, tool: ToolRequest): Promise<ToolResult>;
    };
  }).springBootClient = {
    async saveTranscriptTurn() {}
  };

  (orchestrator as unknown as {
    modelClient: {
      nextTurn(session: CallSession, callerText: string): Promise<ModelTurnResult>;
      continueWithToolResult(session: CallSession, toolResult: unknown): Promise<ModelTurnResult>;
      continueWithPolicyInstruction(session: CallSession, instruction: string, boundaryContext?: unknown): Promise<ModelTurnResult>;
    };
  }).modelClient = {
    async nextTurn() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        collectedFields: {
          selectedAppointmentId: 502,
          callerConfirmedSelectedAppointment: true
        },
        callerAction: explicitConfirmation(),
        toolRequest: {
          name: "GET_NEXT_APPOINTMENT",
          arguments: {
            firstName: "Nancy",
            lastName: "Jones",
            dob: "04/01/2000"
          }
        },
        reply: "I can help confirm that appointment."
      };
    },
    async continueWithToolResult(_session, toolResult) {
      const toolName = typeof toolResult === "object" && toolResult && "name" in (toolResult as Record<string, unknown>)
        ? (toolResult as { name?: unknown }).name
        : undefined;
      return {
        intent: "CONFIRM_APPOINTMENT",
        reply: `Tool result received from ${String(toolName)}.`
      };
    },
    async continueWithPolicyInstruction() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        reply: "To confirm your appointment on August 26, 2026, at 10:00 AM with Dr. David Johnson, should I go ahead and confirm it for you?"
      };
    }
  };

  (orchestrator as unknown as {
    toolExecutor: {
      execute(session: CallSession, tool: ToolRequest): Promise<ToolResult>;
    };
  }).toolExecutor = {
    async execute(_session, tool) {
      executedTools.push(tool);

      if (tool.name === "GET_NEXT_APPOINTMENT") {
        return {
          name: tool.name,
          ok: true,
          data: {
            upcomingAppointments: [
              {
                appointmentId: 502,
                appointmentDate: "10:00 AM on Wednesday, August 26, 2026",
                doctorName: "Dr. David Johnson",
                alreadyConfirmed: false
              },
              {
                appointmentId: 503,
                appointmentDate: "8:20 AM on Thursday, August 27, 2026",
                doctorName: "Dr. David Johnson",
                alreadyConfirmed: false
              }
            ]
          }
        };
      }

      return {
        name: tool.name,
        ok: true
      };
    }
  };

  const outcome = await orchestrator.handleCallerText(session, "August 26 at 10:00 AM, please confirm it.");

  assert.deepEqual(executedTools.map((tool) => tool.name), ["GET_NEXT_APPOINTMENT"]);
  assert.equal(session.pendingActions.CONFIRM_APPOINTMENT?.appointmentId, 502);
  assert.equal(session.pendingActions.CONFIRM_APPOINTMENT?.status, "AWAITING_CALLER_CONFIRMATION");
  assert.ok(session.pendingActions.CONFIRM_APPOINTMENT?.promptedAt);
  assert.match(outcome.reply, /August 26, 2026, at 10:00 AM/i);
});

test("asks for explicit confirmation after caller selects an appointment from multiple options", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({
    callSid: "CA-august-27",
    officeCode: "MSHNN"
  });
  session.currentIntent = "CONFIRM_APPOINTMENT";
  session.collectedFields.firstName = "Nancy";
  session.collectedFields.dob = "2000-04-01";
  session.lastToolResults.GET_NEXT_APPOINTMENT = {
    name: "GET_NEXT_APPOINTMENT",
    ok: true,
    data: {
      upcomingAppointments: [
        {
          appointmentId: 502,
          appointmentDate: "10:00 AM on Wednesday, August 26, 2026",
          doctorName: "Dr. David Johnson",
          alreadyConfirmed: false
        },
        {
          appointmentId: 503,
          appointmentDate: "8:20 AM on Thursday, August 27, 2026",
          doctorName: "Dr. David Johnson",
          alreadyConfirmed: false
        }
      ]
    }
  };
  session.transcript.push({
    speaker: "assistant",
    text: "Neither appointment is confirmed yet. Would you like to confirm one of these appointments now? If so, please tell me which one.",
    at: "2026-08-25T10:25:52.007Z"
  });

  const executedTools: ToolRequest[] = [];

  (orchestrator as unknown as {
    springBootClient: {
      saveTranscriptTurn(input: unknown): Promise<void>;
    };
    modelClient: {
      nextTurn(session: CallSession, callerText: string): Promise<ModelTurnResult>;
      continueWithToolResult(session: CallSession, toolResult: unknown): Promise<ModelTurnResult>;
      continueWithPolicyInstruction(session: CallSession, instruction: string, boundaryContext?: unknown): Promise<ModelTurnResult>;
    };
    toolExecutor: {
      execute(session: CallSession, tool: ToolRequest): Promise<ToolResult>;
    };
  }).springBootClient = {
    async saveTranscriptTurn() {}
  };

  (orchestrator as unknown as {
    modelClient: {
      nextTurn(session: CallSession, callerText: string): Promise<ModelTurnResult>;
      continueWithToolResult(session: CallSession, toolResult: unknown): Promise<ModelTurnResult>;
      continueWithPolicyInstruction(session: CallSession, instruction: string, boundaryContext?: unknown): Promise<ModelTurnResult>;
    };
  }).modelClient = {
    async nextTurn() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        collectedFields: {
          selectedAppointmentId: 503,
          callerConfirmedSelectedAppointment: true
        },
        callerAction: explicitConfirmation(),
        toolRequest: {
          name: "CONFIRM_APPOINTMENT",
          arguments: {}
        },
        reply: "I can help with that."
      };
    },
    async continueWithToolResult() {
      throw new Error("confirmation should not execute before the workflow confirmation prompt");
    },
    async continueWithPolicyInstruction() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        reply: "To confirm your appointment on August 27, 2026, at 8:20 AM with Dr. David Johnson, should I go ahead and confirm it for you?"
      };
    }
  };

  (orchestrator as unknown as {
    toolExecutor: {
      execute(session: CallSession, tool: ToolRequest): Promise<ToolResult>;
    };
  }).toolExecutor = {
    async execute(_session, tool) {
      executedTools.push(tool);
      return {
        name: tool.name,
        ok: true
      };
    }
  };

  const outcome = await orchestrator.handleCallerText(session, "Can you book can you confirm on August 27?");

  assert.deepEqual(executedTools.map((tool) => tool.name), []);
  assert.equal(session.pendingActions.CONFIRM_APPOINTMENT?.appointmentId, 503);
  assert.equal(session.pendingActions.CONFIRM_APPOINTMENT?.status, "AWAITING_CALLER_CONFIRMATION");
  assert.ok(session.pendingActions.CONFIRM_APPOINTMENT?.promptedAt);
  assert.match(outcome.reply, /August 27, 2026, at 8:20 AM/i);
});

test("returns a bounded choice prompt when confirmation is still ambiguous", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({
    callSid: "CA-reprompt-guard",
    officeCode: "MSHNN"
  });
  session.currentIntent = "CONFIRM_APPOINTMENT";
  session.lastToolResults.GET_NEXT_APPOINTMENT = {
    name: "GET_NEXT_APPOINTMENT",
    ok: true,
    data: {
      upcomingAppointments: [
        {
          appointmentId: 502,
          appointmentDate: "10:00 AM on Wednesday, August 26, 2026",
          doctorName: "Dr. David Johnson",
          alreadyConfirmed: false
        },
        {
          appointmentId: 503,
          appointmentDate: "8:20 AM on Thursday, August 27, 2026",
          doctorName: "Dr. David Johnson",
          alreadyConfirmed: false
        }
      ]
    }
  };

  (orchestrator as unknown as {
    springBootClient: {
      saveTranscriptTurn(input: unknown): Promise<void>;
    };
    modelClient: {
      nextTurn(session: CallSession, callerText: string): Promise<ModelTurnResult>;
      continueWithToolResult(session: CallSession, toolResult: unknown): Promise<ModelTurnResult>;
      continueWithPolicyInstruction(session: CallSession, instruction: string, boundaryContext?: unknown): Promise<ModelTurnResult>;
    };
    toolExecutor: {
      execute(session: CallSession, tool: ToolRequest): Promise<ToolResult>;
    };
  }).springBootClient = {
    async saveTranscriptTurn() {}
  };

  (orchestrator as unknown as {
    modelClient: {
      nextTurn(session: CallSession, callerText: string): Promise<ModelTurnResult>;
      continueWithToolResult(session: CallSession, toolResult: unknown): Promise<ModelTurnResult>;
      continueWithPolicyInstruction(session: CallSession, instruction: string, boundaryContext?: unknown): Promise<ModelTurnResult>;
    };
  }).modelClient = {
    async nextTurn() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        toolRequest: {
          name: "CONFIRM_APPOINTMENT",
          arguments: {}
        },
        reply: "I can help with that."
      };
    },
    async continueWithToolResult() {
      throw new Error("tool execution should not happen for unresolved appointment selection");
    },
    async continueWithPolicyInstruction() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        reply: "There are multiple appointments available to confirm: August 26, 2026, and August 27, 2026. Which one would you like to confirm?"
      };
    }
  };

  (orchestrator as unknown as {
    toolExecutor: {
      execute(session: CallSession, tool: ToolRequest): Promise<ToolResult>;
    };
  }).toolExecutor = {
    async execute() {
      throw new Error("tool execution should not happen for unresolved appointment selection");
    }
  };

  const outcome = await orchestrator.handleCallerText(session, "Okay. I want to confirm appointment.");

  assert.match(outcome.reply, /multiple appointments available to confirm/i);
  assert.match(outcome.reply, /August 26, 2026/i);
  assert.match(outcome.reply, /August 27, 2026/i);
});

test("refreshes and confirms the newly selected appointment after an earlier confirmation", async () => {
  const sessions = new CallSessionStore();
  const orchestrator = new AiReceptionistOrchestrator(sessions);
  const session = sessions.create({
    callSid: "CA-confirm-after-confirm",
    officeCode: "MSHNN",
    fromNumber: "+15551234567"
  });
  session.currentIntent = "CONFIRM_APPOINTMENT";
  session.collectedFields = { firstName: "Mary", dob: "01/01/2004" };
  session.lastToolResults.CONFIRM_APPOINTMENT = { name: "CONFIRM_APPOINTMENT", ok: true };
  session.workflowState = {
    contractVersion: 1,
    workflow: "CONFIRM_APPOINTMENT",
    state: "COMPLETED",
    allowedActions: [],
    context: { selectedAppointmentId: 93103, alreadyConfirmed: false }
  };

  const executedTools: ToolRequest[] = [];
  Object.defineProperty(orchestrator, "modelClient", { value: {
    async nextTurn() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        callerAction: explicitConfirmation(),
        toolRequest: {
          name: "CONFIRM_APPOINTMENT",
          arguments: { appointmentId: 93103 }
        },
        reply: "I can confirm that appointment."
      };
    },
    async continueWithToolResult() {
      throw new Error("successful confirmation should use the deterministic backend-backed reply");
    },
    async continueWithPolicyInstruction() {
      throw new Error("successful confirmation should not use a policy reprompt");
    }
  } });
  Object.defineProperty(orchestrator, "toolExecutor", { value: {
    async execute(_session: CallSession, tool: ToolRequest): Promise<ToolResult> {
      executedTools.push(tool);
      if (tool.name === "GET_NEXT_APPOINTMENT") {
        return {
          name: tool.name,
          ok: true,
          data: {
            appointmentId: 93102,
            upcomingAppointments: [
              {
                appointmentId: 93103,
                appointmentDate: "12:30 PM on Friday, October 2, 2026",
                alreadyConfirmed: true
              },
              {
                appointmentId: 93102,
                appointmentDate: "10:00 AM on Tuesday, September 29, 2026",
                alreadyConfirmed: false
              }
            ]
          }
        };
      }
      return {
        name: tool.name,
        ok: true,
        workflowState: {
          contractVersion: 1,
          workflow: "CONFIRM_APPOINTMENT",
          state: "COMPLETED",
          allowedActions: [],
          context: { selectedAppointmentId: 93102, alreadyConfirmed: false }
        }
      };
    }
  } });

  const outcome = await orchestrator.handleCallerText(session, "Okay. Let's confirm it.", { recordCallerTurn: false });

  assert.deepEqual(executedTools.map((tool) => tool.name), ["GET_NEXT_APPOINTMENT", "CONFIRM_APPOINTMENT"]);
  assert.equal(executedTools[1]?.arguments?.appointmentId, 93102);
  assert.match(outcome.reply, /September 29, 2026/i);
  assert.equal(outcome.shouldTransferToStaff, false);
});

function buildSession(store: CallSessionStore): CallSession {
  const session = store.create({
    callSid: "CA-test",
    officeCode: "MSHNN"
  });

  session.currentIntent = "CONFIRM_APPOINTMENT";
  session.pendingActions.CONFIRM_APPOINTMENT = {
    appointmentId: 503,
    status: "AWAITING_CALLER_CONFIRMATION",
    createdAt: "2026-08-25T06:13:26.843Z"
  };
  session.appointmentSelections.CONFIRM_APPOINTMENT = {
    createdAt: "2026-08-25T06:13:01.283Z",
    options: [
      {
        appointmentId: 502,
        appointmentDate: "10:00 AM on Wednesday, August 26, 2026",
        doctorName: "Dr. David Johnson",
        source: {
          appointmentId: 502,
          appointmentDate: "10:00 AM on Wednesday, August 26, 2026",
          doctorName: "Dr. David Johnson"
        }
      },
      {
        appointmentId: 503,
        appointmentDate: "8:20 AM on Thursday, August 27, 2026",
        doctorName: "Dr. David Johnson",
        source: {
          appointmentId: 503,
          appointmentDate: "8:20 AM on Thursday, August 27, 2026",
          doctorName: "Dr. David Johnson"
        }
      }
    ]
  };
  session.transcript.push({
    speaker: "assistant",
    text: "To confirm your appointment on August 27, 2026, at 8:20 AM with Dr. David Johnson, should I go ahead and confirm it for you?",
    at: "2026-08-25T06:14:33.879Z"
  });

  return session;
}

function explicitConfirmation() {
  return {
    speechAct: "AUTHORIZATION" as const,
    workflowIntent: "CONFIRM_APPOINTMENT" as const,
    requestedAction: "CONFIRM_SELECTED_APPOINTMENT" as const,
    authorization: {
      stateChangingAction: "CONFIRM_APPOINTMENT" as const,
      isExplicit: true
    }
  };
}
