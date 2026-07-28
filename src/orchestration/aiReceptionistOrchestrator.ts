import { ModelClient, ModelTurnResult } from "../ai/modelClient.js";
import { SpringBootClient } from "../clients/springBootClient.js";
import { CallSession, CallSessionStore } from "../sessions/callSession.js";
import { ToolRegistry } from "../tools/toolRegistry.js";
import { logger } from "../utils/logger.js";

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

  async handleCallerText(session: CallSession, callerText: string): Promise<string> {
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
    const reply = finalResult.reply ?? "I am sorry, I could not complete that request.";

    if (finalResult.intent) {
      session.currentIntent = finalResult.intent;
    }
    if (finalResult.collectedFields) {
      session.collectedFields = {
        ...session.collectedFields,
        ...finalResult.collectedFields
      };
    }

    this.sessions.append(session, {
      speaker: "assistant",
      text: reply,
      metadata: {
        intent: finalResult.intent
      }
    });
    await this.trySaveTranscriptTurn({
      callSid: session.callSid,
      officeCode: session.officeCode,
      speaker: "assistant",
      text: reply,
      metadata: {
        intent: finalResult.intent
      }
    });

    return reply;
  }

  async completeSession(session: CallSession): Promise<void> {
    await this.tryCompleteCall({
      callSid: session.callSid,
      officeCode: session.officeCode,
      transcript: session.transcript,
      collectedFields: session.collectedFields,
      lastToolResults: session.lastToolResults
    });
    this.sessions.delete(session.callSid);
  }

  private async resolveModelResult(session: CallSession, result: ModelTurnResult): Promise<ModelTurnResult> {
    if (!result.toolRequest) {
      return result;
    }

    const toolResult = await this.toolRegistry.execute(session, result.toolRequest);
    session.lastToolResults[result.toolRequest.name] = toolResult;
    this.sessions.append(session, {
      speaker: "tool",
      text: JSON.stringify(toolResult),
      metadata: {
        toolName: result.toolRequest.name
      }
    });

    return this.modelClient.continueWithToolResult(session, toolResult);
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
}
