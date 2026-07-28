import { WebSocket } from "ws";
import { AiReceptionistOrchestrator } from "../orchestration/aiReceptionistOrchestrator.js";
import { CallSessionStore } from "../sessions/callSession.js";
import {
  ConversationRelayMessage,
  ConversationRelayResponse,
  ConversationRelaySetupMessage
} from "../types/conversationRelay.js";
import { logger } from "../utils/logger.js";

export class ConversationRelayHandler {
  private readonly sessions = new CallSessionStore();
  private readonly orchestrator = new AiReceptionistOrchestrator(this.sessions);

  async handleConnection(ws: WebSocket): Promise<void> {
    let callSid: string | undefined;

    ws.on("message", async (raw) => {
      try {
        const message = this.parseMessage(raw.toString());
        logger.debug("Conversation Relay message received", { type: message.type, callSid });

        if (this.isSetupMessage(message)) {
          const session = await this.handleSetup(message);
          callSid = session.callSid;
          if (message.customParameters?.welcomeGreetingProvided !== "true") {
            this.send(ws, {
              type: "text",
              token: session.officeContext?.aiGreeting ?? "Thank you for calling. How can I help you today?",
              last: true
            });
          }
          return;
        }

        if (!callSid) {
          logger.warn("Received non-setup message before callSid was known", message);
          return;
        }

        const session = this.sessions.get(callSid);
        if (!session) {
          logger.warn("No session found for message", { callSid, type: message.type });
          return;
        }

        if (this.isPromptMessage(message)) {
          const callerText = message.voicePrompt?.trim();
          if (!callerText) {
            return;
          }
          const reply = await this.orchestrator.handleCallerText(session, callerText);
          this.send(ws, {
            type: "text",
            token: reply,
            last: true
          });
          return;
        }

        if (message.type === "interrupt") {
          logger.info("Caller interrupted AI response", {
            callSid,
            utteranceUntilInterrupt: message.utteranceUntilInterrupt
          });
          return;
        }

        if (message.type === "dtmf") {
          logger.info("DTMF received", { callSid, digit: message.digit });
          return;
        }

        if (message.type === "error") {
          logger.error("Twilio Conversation Relay error", { callSid, description: message.description });
        }
      } catch (error) {
        logger.error("Failed to handle Conversation Relay message", { error: String(error) });
        this.send(ws, {
          type: "text",
          token: "I am sorry, something went wrong. I will notify the office.",
          last: true
        });
      }
    });

    ws.on("close", async () => {
      if (!callSid) {
        return;
      }
      const session = this.sessions.get(callSid);
      if (!session) {
        return;
      }
      try {
        await this.orchestrator.completeSession(session);
        logger.info("Conversation Relay session completed", { callSid });
      } catch (error) {
        logger.error("Failed to complete Conversation Relay session", { callSid, error: String(error) });
      }
    });
  }

  private async handleSetup(message: ConversationRelaySetupMessage) {
    const callSid = message.callSid ?? message.customParameters?.callSid;
    const officeCode = message.customParameters?.officeCode ?? message.customParameters?.officeId;

    if (!callSid) {
      throw new Error("Conversation Relay setup missing callSid");
    }
    if (!officeCode) {
      throw new Error("Conversation Relay setup missing officeCode custom parameter");
    }

    const session = await this.orchestrator.initializeSession({
      callSid,
      officeCode,
      accountSid: message.accountSid,
      fromNumber: message.from ?? message.customParameters?.fromNumber,
      toNumber: message.to ?? message.customParameters?.toNumber
    });
    logger.info("Conversation Relay session initialized", { callSid, officeCode });
    return session;
  }

  private parseMessage(raw: string): ConversationRelayMessage {
    return JSON.parse(raw) as ConversationRelayMessage;
  }

  private isSetupMessage(message: ConversationRelayMessage): message is ConversationRelaySetupMessage {
    return message.type === "setup";
  }

  private isPromptMessage(message: ConversationRelayMessage): message is ConversationRelayMessage & { type: "prompt"; voicePrompt?: string } {
    return message.type === "prompt" && (message.voicePrompt === undefined || typeof message.voicePrompt === "string");
  }

  private send(ws: WebSocket, response: ConversationRelayResponse): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(response));
  }
}
