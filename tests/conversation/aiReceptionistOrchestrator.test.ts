import assert from "node:assert/strict";
import test from "node:test";
import { CallSession, CallSessionStore } from "../../src/calls/callSession.js";
import { AiReceptionistOrchestrator } from "../../src/conversation/aiReceptionistOrchestrator.js";
import { ModelTurnResult } from "../../src/conversation/modelClient.js";
import { ToolRequest, ToolResult } from "../../src/backend/springBootClient.js";

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

test("executes confirmation in one turn when caller names the appointment and asks to confirm it", async () => {
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
    };
  }).modelClient = {
    async nextTurn() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        collectedFields: {
          selectedAppointmentId: 502,
          callerConfirmedSelectedAppointment: true
        },
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
      if (toolName === "GET_NEXT_APPOINTMENT") {
        throw new Error("lookup should flow directly into confirmation before a caller-facing reply");
      }

      return {
        intent: "CONFIRM_APPOINTMENT",
        reply: "Your appointment on August 26, 2026, at 10:00 AM with Dr. David Johnson is confirmed."
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

  assert.deepEqual(executedTools.map((tool) => tool.name), ["GET_NEXT_APPOINTMENT", "CONFIRM_APPOINTMENT"]);
  assert.equal(executedTools[1]?.arguments.appointmentId, 502);
  assert.equal(executedTools[1]?.arguments.callerConfirmedSelectedAppointment, true);
  assert.equal(session.pendingActions.CONFIRM_APPOINTMENT, undefined);
  assert.equal(session.collectedFields.selectedAppointmentId, undefined);
  assert.equal(session.collectedFields.callerConfirmedSelectedAppointment, undefined);
  assert.match(outcome.reply, /August 26, 2026, at 10:00 AM/i);
});

test("executes confirmation when caller says confirm on August 27 after hearing multiple appointments", async () => {
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
    };
  }).modelClient = {
    async nextTurn() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        collectedFields: {
          selectedAppointmentId: 503,
          callerConfirmedSelectedAppointment: true
        },
        toolRequest: {
          name: "CONFIRM_APPOINTMENT",
          arguments: {}
        },
        reply: "I can help with that."
      };
    },
    async continueWithToolResult() {
      return {
        intent: "CONFIRM_APPOINTMENT",
        reply: "Your appointment on August 27, 2026, at 8:20 AM with Dr. David Johnson is confirmed."
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

  assert.deepEqual(executedTools.map((tool) => tool.name), ["CONFIRM_APPOINTMENT"]);
  assert.equal(executedTools[0]?.arguments.appointmentId, 503);
  assert.equal(executedTools[0]?.arguments.callerConfirmedSelectedAppointment, true);
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
