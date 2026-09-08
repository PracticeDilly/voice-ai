import OpenAI from "openai";
import { config } from "../config/env.js";
import { ToolRequest } from "../backend/springBootClient.js";
import { CallSession } from "../calls/callSession.js";
import { ToolPolicyBoundaryContext } from "../workflows/shared/workflowTypes.js";
import type { CallerActionDecision } from "../workflows/shared/callerActionDecision.js";
import { buildSystemPrompt } from "./promptBuilder.js";
import { BookingWorkflowError, bookingModelContractError } from "../workflows/bookAppointment/bookingModelContract.js";
import { bookingResponseContext, bookingResponseInstruction, BookingResponsePurpose } from "../workflows/bookAppointment/bookingResponseContext.js";
import { logger } from "../utils/logger.js";

export interface ModelTurnResult {
  reply?: string;
  toolRequest?: ToolRequest;
  intent?: string;
  callerAction?: CallerActionDecision;
  collectedFields?: Record<string, unknown>;
  shouldEndCall?: boolean;
}

export interface ModelCallSummary {
  summaryText: string;
  primaryIntent?: string;
  staffFollowupRequired?: boolean;
  priority?: string;
}

export class ModelClient {
  private readonly client = new OpenAI({
    apiKey: config.OPENAI_API_KEY
  });

  async nextTurn(session: CallSession, callerText: string): Promise<ModelTurnResult> {
    return this.createModelTurn(session, {
      callerText,
      currentIntent: session.currentIntent,
      workflowState: session.workflowState,
      conversationHistory: session.transcript.slice(-12),
      lastAssistantReply: this.findLastAssistantReply(session),
      collectedFields: session.collectedFields,
      lastToolResults: session.lastToolResults,
      pendingActions: session.pendingActions,
      appointmentSelections: session.appointmentSelections
    });
  }

  async continueWithToolResult(session: CallSession, toolResult: unknown): Promise<ModelTurnResult> {
    return this.createModelTurn(session, {
      instruction: "Use this tool result to produce the next caller-facing response.",
      currentIntent: session.currentIntent,
      workflowState: session.workflowState,
      toolResult,
      conversationHistory: session.transcript.slice(-12),
      lastAssistantReply: this.findLastAssistantReply(session),
      lastCallerReply: this.findLastCallerReply(session),
      collectedFields: session.collectedFields,
      pendingActions: session.pendingActions,
      appointmentSelections: session.appointmentSelections
    });
  }

  async continueWithPolicyInstruction(
    session: CallSession,
    instruction: string,
    boundaryContext?: ToolPolicyBoundaryContext
  ): Promise<ModelTurnResult> {
    return this.createModelTurn(session, {
      instruction,
      boundaryContext,
      currentIntent: session.currentIntent,
      workflowState: session.workflowState,
      conversationHistory: session.transcript.slice(-12),
      lastAssistantReply: this.findLastAssistantReply(session),
      lastCallerReply: this.findLastCallerReply(session),
      collectedFields: session.collectedFields,
      pendingActions: session.pendingActions,
      appointmentSelections: session.appointmentSelections
    });
  }

  async bookingResponse(session: CallSession, purpose: BookingResponsePurpose): Promise<ModelTurnResult> {
    const content = await this.requestModelContent(session, {
      instruction: bookingResponseInstruction,
      responseContext: bookingResponseContext(session, purpose),
      conversationHistory: session.transcript.slice(-12)
    });
    let reply: unknown;
    try {
      reply = JSON.parse(content).reply;
    } catch {
      throw new BookingWorkflowError("Invalid booking response JSON");
    }
    if (typeof reply !== "string" || !reply.trim()) {
      throw new BookingWorkflowError("Missing booking response");
    }
    // Wording is model-owned; this response-only call cannot change execution state.
    return { reply, intent: purpose === "HANDOFF" ? "TRANSFER_TO_STAFF" : "BOOK_APPOINTMENT", shouldEndCall: purpose === "HANDOFF" };
  }

  async summarizeCall(session: CallSession): Promise<ModelCallSummary> {
    const response = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You summarize dental/healthcare AI receptionist calls for office staff.",
            "Return only valid JSON.",
            "The JSON shape is: {\"summaryText\": string, \"primaryIntent\": string, \"staffFollowupRequired\": boolean, \"priority\": \"LOW\"|\"NORMAL\"|\"HIGH\"}.",
            "summaryText must be a short human-readable summary for office staff, usually 1 to 3 sentences.",
            "Do not invent patient data or appointment confirmations."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            officeCode: session.officeCode,
            officeName: session.officeContext?.officeName,
            currentIntent: session.currentIntent,
            workflowState: session.workflowState,
            collectedFields: session.collectedFields,
            lastToolResults: session.lastToolResults,
            pendingActions: session.pendingActions,
            appointmentSelections: session.appointmentSelections,
            transcript: session.transcript
          })
        }
      ]
    }, {
      timeout: config.AI_MODEL_TIMEOUT_MS
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    return this.parseCallSummary(content, session);
  }

  private parseModelResult(content: string): ModelTurnResult {
    try {
      const parsed = JSON.parse(content) as ModelTurnResult;
      if (!parsed.toolRequest?.name?.trim()) {
        delete parsed.toolRequest;
      }
      return parsed;
    } catch {
      return {
        reply: "I am sorry, I had trouble understanding that. Let me connect you with the office.",
        toolRequest: {
          name: "TRANSFER_TO_STAFF",
          arguments: {}
        },
        intent: "TRANSFER_TO_STAFF"
      };
    }
  }

  private async requestModelContent(session: CallSession, payload: Record<string, unknown>): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(session)
        },
        {
          role: "user",
          content: JSON.stringify(payload)
        }
      ]
    }, {
      timeout: config.AI_MODEL_TIMEOUT_MS
    });

    return response.choices[0]?.message?.content ?? "{}";
  }

  private async createModelTurn(session: CallSession, payload: Record<string, unknown>, repairAttempt = 0): Promise<ModelTurnResult> {
    const content = await this.requestModelContent(session, payload);
    const result = this.parseModelResult(content);
    const contractError = bookingModelContractError(session, result);
    if (!contractError) return result;

    logger.warn("Booking model contract rejected", {
      callSid: session.callSid,
      repairAttempt,
      argumentFields: Object.keys(result.toolRequest?.arguments ?? {}),
      collectedFieldNames: Object.keys(result.collectedFields ?? {})
    });
    if (repairAttempt === 0) {
      return this.createModelTurn(session, {
        ...payload,
        rejectedModelResult: result,
        validationError: contractError,
        instruction: "Correct your previous JSON using the tool contract and known conversation context. Recover known values without asking the caller to repeat them. If information is genuinely missing or ambiguous, ask naturally instead of requesting a tool."
      }, repairAttempt + 1);
    }
    throw new BookingWorkflowError("Booking model contract remained invalid after correction");
  }

  private findLastAssistantReply(session: CallSession): string | undefined {
    for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
      const turn = session.transcript[index];
      if (turn.speaker === "assistant") {
        return turn.text;
      }
    }

    return undefined;
  }

  private findLastCallerReply(session: CallSession): string | undefined {
    for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
      const turn = session.transcript[index];
      if (turn.speaker === "patient") {
        return turn.text;
      }
    }

    return undefined;
  }

  private parseCallSummary(content: string, session: CallSession): ModelCallSummary {
    try {
      const parsed = JSON.parse(content) as ModelCallSummary;
      const summaryText = parsed.summaryText?.trim() || "AI receptionist call completed. Staff can review the transcript for details.";
      return {
        ...parsed,
        summaryText,
        primaryIntent: parsed.primaryIntent ?? session.currentIntent,
        staffFollowupRequired: parsed.staffFollowupRequired ?? false,
        priority: parsed.priority ?? "NORMAL"
      };
    } catch {
      const summaryText = "AI receptionist call completed. Staff can review the transcript for details.";
      return {
        summaryText,
        primaryIntent: session.currentIntent,
        staffFollowupRequired: true,
        priority: "NORMAL"
      };
    }
  }
}
