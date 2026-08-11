import { ModelClient, ModelTurnResult } from "../ai/modelClient.js";
import { SpringBootClient } from "../clients/springBootClient.js";
import { CallSession, CallSessionStore } from "../sessions/callSession.js";
import { ToolRegistry } from "../tools/toolRegistry.js";
import { logger } from "../utils/logger.js";

export interface ConversationTurnOutcome {
  reply: string;
  shouldEndSession: boolean;
  shouldTransferToStaff: boolean;
  handoffData?: Record<string, unknown>;
}

export class AiReceptionistOrchestrator {
  private readonly springBootClient = new SpringBootClient();
  private readonly toolRegistry = new ToolRegistry(this.springBootClient);
  private readonly modelClient = new ModelClient();

  constructor(private readonly sessions: CallSessionStore) {}

  async initializeSession(input: {
    callSid: string;
    accountSid?: string;
    officeCode: string;
    fromNumber?: string;
    toNumber?: string;
  }): Promise<CallSession> {
    const session = this.sessions.create(input);
    session.officeContext = await this.springBootClient.getOfficeContext(input.officeCode, input.callSid);
    this.sessions.append(session, {
      speaker: "system",
      text: "AI receptionist session initialized.",
      metadata: {
        officeCode: input.officeCode,
        fromNumber: input.fromNumber,
        toNumber: input.toNumber
      }
    });
    return session;
  }

  async handleCallerText(session: CallSession, callerText: string): Promise<ConversationTurnOutcome> {
    this.sessions.append(session, {
      speaker: "patient",
      text: callerText
    });
    await this.trySaveTranscriptTurn({
      callSid: session.callSid,
      officeCode: session.officeCode,
      speaker: "patient",
      text: callerText
    });

    const firstResult = await this.modelClient.nextTurn(session, callerText);
    const finalResult = await this.resolveModelResult(session, firstResult);
    const fallbackEndCall = !this.shouldTransferToStaff(firstResult, finalResult) && finalResult.shouldEndCall !== true
      ? await this.modelClient.shouldEndCall(session, callerText)
      : false;
    const reply = finalResult.reply ?? "I am sorry, I could not complete that request.";
    const transferToStaff = this.shouldTransferToStaff(firstResult, finalResult);
    const shouldEndSession = transferToStaff || finalResult.shouldEndCall === true || fallbackEndCall;

    logger.info("AI turn completed", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      currentIntent: session.currentIntent,
      finalIntent: finalResult.intent,
      shouldEndSession,
      shouldTransferToStaff: transferToStaff,
      fallbackEndCall
    });

    if (finalResult.intent) {
      session.currentIntent = finalResult.intent;
    }
    if (finalResult.collectedFields) {
      session.collectedFields = {
        ...session.collectedFields,
        ...finalResult.collectedFields
      };
    }

    await this.recordAssistantTurn(session, reply, {
      intent: finalResult.intent
    });

    return {
      reply,
      shouldEndSession,
      shouldTransferToStaff: transferToStaff,
      handoffData: transferToStaff ? {
        reasonCode: "live-agent-handoff",
        reason: "Caller requested live office staff or AI could not safely complete the request.",
        officeCode: session.officeCode,
        callSid: session.callSid,
        fromNumber: session.fromNumber,
        toNumber: session.toNumber,
        intent: finalResult.intent,
        collectedFields: session.collectedFields
      } : undefined
    };
  }

  async completeSession(session: CallSession): Promise<void> {
    const summary = await this.trySummarizeCall(session);
    await this.tryCompleteCall({
      callSid: session.callSid,
      officeCode: session.officeCode,
      transcript: session.transcript,
      collectedFields: session.collectedFields,
      lastToolResults: session.lastToolResults,
      summary
    });
    this.sessions.delete(session.callSid);
  }

  async recordAssistantTurn(
    session: CallSession,
    text: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.sessions.append(session, {
      speaker: "assistant",
      text,
      metadata
    });
    await this.trySaveTranscriptTurn({
      callSid: session.callSid,
      officeCode: session.officeCode,
      speaker: "assistant",
      text,
      metadata
    });
  }

  private async resolveModelResult(session: CallSession, result: ModelTurnResult): Promise<ModelTurnResult> {
    if (!result.toolRequest) {
      return result;
    }

    logger.info("AI tool request started", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      toolName: result.toolRequest.name,
      arguments: result.toolRequest.arguments
    });
    const toolResult = await this.tryExecuteTool(session, result.toolRequest);
    session.lastToolResults[result.toolRequest.name] = toolResult;
    this.sessions.append(session, {
      speaker: "tool",
      text: JSON.stringify(toolResult),
      metadata: {
        toolName: result.toolRequest.name
      }
    });
    logger.info("AI tool request finished", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      toolName: result.toolRequest.name,
      ok: typeof toolResult === "object" && toolResult !== null && "ok" in toolResult ? (toolResult as { ok?: unknown }).ok : undefined
    });

    return this.modelClient.continueWithToolResult(session, toolResult);
  }

  private shouldTransferToStaff(firstResult: ModelTurnResult, finalResult: ModelTurnResult): boolean {
    return firstResult.toolRequest?.name === "TRANSFER_TO_STAFF"
      || finalResult.toolRequest?.name === "TRANSFER_TO_STAFF"
      || finalResult.intent === "TRANSFER_TO_STAFF";
  }

  private async tryExecuteTool(session: CallSession, toolRequest: NonNullable<ModelTurnResult["toolRequest"]>) {
    try {
      return await this.toolRegistry.execute(session, toolRequest);
    } catch (error) {
      logger.warn("Unable to execute AI tool; continuing with failure result", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        toolName: toolRequest.name,
        error: String(error)
      });
      return {
        name: toolRequest.name,
        ok: false,
        error: "The office system is unavailable for that request right now. Offer to send a message to the office staff."
      };
    }
  }

  private async trySaveTranscriptTurn(input: {
    callSid: string;
    officeCode: string;
    speaker: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.springBootClient.saveTranscriptTurn(input);
    } catch (error) {
      logger.warn("Unable to save AI transcript turn; continuing conversation", {
        callSid: input.callSid,
        officeCode: input.officeCode,
        speaker: input.speaker,
        error: String(error)
      });
    }
  }

  private async tryCompleteCall(input: {
    callSid: string;
    officeCode: string;
    transcript: unknown[];
    collectedFields: Record<string, unknown>;
    lastToolResults: Record<string, unknown>;
    summary?: Awaited<ReturnType<ModelClient["summarizeCall"]>>;
  }): Promise<void> {
    try {
      await this.springBootClient.completeCall(input);
    } catch (error) {
      logger.warn("Unable to complete AI call record; closing in-memory session", {
        callSid: input.callSid,
        officeCode: input.officeCode,
        error: String(error)
      });
    }
  }

  private async trySummarizeCall(session: CallSession): Promise<Awaited<ReturnType<ModelClient["summarizeCall"]>> | undefined> {
    try {
      return await this.modelClient.summarizeCall(session);
    } catch (error) {
      logger.warn("Unable to generate AI call summary; completing call without summary", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        error: String(error)
      });
      return undefined;
    }
  }
}
