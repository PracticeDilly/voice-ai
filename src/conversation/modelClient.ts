import OpenAI from "openai";
import { config } from "../config/env.js";
import { ToolRequest } from "../backend/springBootClient.js";
import { CallSession } from "../calls/callSession.js";
import { ToolPolicyBoundaryContext } from "../workflows/shared/workflowTypes.js";
import type { CallerActionDecision } from "../workflows/shared/callerActionDecision.js";
import { buildSystemPrompt } from "./promptBuilder.js";

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

  private async createModelTurn(session: CallSession, payload: Record<string, unknown>): Promise<ModelTurnResult> {
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
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    return this.parseModelResult(content);
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
