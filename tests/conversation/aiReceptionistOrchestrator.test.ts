import assert from "node:assert/strict";
import test from "node:test";
import { CallSession, CallSessionStore } from "../../src/calls/callSession.js";
import { AiReceptionistOrchestrator } from "../../src/conversation/aiReceptionistOrchestrator.js";
import { ModelTurnResult } from "../../src/conversation/modelClient.js";
import { ToolRequest, ToolResult } from "../../src/backend/springBootClient.js";
import { BookingWorkflowError } from "../../src/workflows/bookAppointment/bookingModelContract.js";

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
  assert.equal(outcome.shouldTransferToStaff, true);
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
  assert.equal(outcome.shouldTransferToStaff, true);
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
        reply: purpose === "HANDOFF" ? "Our team can help with this visit." : "Shall I reserve that appointment for you?",
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
