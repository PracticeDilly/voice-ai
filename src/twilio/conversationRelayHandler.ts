import { WebSocket } from "ws";
import { config } from "../config/env.js";
import { AiReceptionistOrchestrator } from "../orchestration/aiReceptionistOrchestrator.js";
import { CallSession, CallSessionStore } from "../sessions/callSession.js";
import {
  ConversationRelayMessage,
  ConversationRelayResponse,
  ConversationRelaySetupMessage
} from "../types/conversationRelay.js";
import { logger } from "../utils/logger.js";

interface CommittedPrompt {
  turnId: number;
  text: string;
  observedInputVersion: number;
}

interface PromptProcessingContext {
  session: CallSession;
  callerText: string;
  ws: WebSocket;
  expectedInterruptionGeneration: number;
  getInterruptionGeneration: () => number;
  turnId: number;
  expectedObservedInputVersion: number;
  getLatestObservedInputVersion: () => number;
  getNoInputTimer: () => ReturnType<typeof setTimeout> | undefined;
  setNoInputTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void;
  getNoInputCount: () => number;
  setNoInputCount: (value: number) => void;
  setEndingSession: (value: boolean) => void;
}

export class ConversationRelayHandler {
  private readonly sessions = new CallSessionStore();
  private readonly orchestrator = new AiReceptionistOrchestrator(this.sessions);

  async handleConnection(ws: WebSocket): Promise<void> {
    let callSid: string | undefined;
    let processingPrompt = false;
    let pendingPromptParts: string[] = [];
    let lastProcessedPrompt: { text: string; at: number } | undefined;
    let interruptionGeneration = 0;
    let pendingPromptTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingPromptResolvers: Array<(value: CommittedPrompt | undefined) => void> = [];
    let committedPromptQueue: CommittedPrompt[] = [];
    let noInputTimer: ReturnType<typeof setTimeout> | undefined;
    let noInputCount = 0;
    let nextTurnId = 0;
    let latestObservedInputVersion = 0;
    let endingSession = false;

    const processCommittedPrompts = async (session: CallSession): Promise<void> => {
      if (processingPrompt) {
        return;
      }

      processingPrompt = true;
      try {
        while (true) {
          const nextPrompt = await this.awaitCommittedPrompt(committedPromptQueue, pendingPromptResolvers);
          if (!nextPrompt) {
            break;
          }

          if (this.wasRecentlyProcessed(nextPrompt.text, lastProcessedPrompt)) {
            logger.info("Skipping duplicate committed final prompt", { callSid, callerText: nextPrompt.text });
            continue;
          }

          lastProcessedPrompt = await this.processPrompt({
            session,
            callerText: nextPrompt.text,
            ws,
            expectedInterruptionGeneration: interruptionGeneration,
            getInterruptionGeneration: () => interruptionGeneration,
            turnId: nextPrompt.turnId,
            expectedObservedInputVersion: nextPrompt.observedInputVersion,
            getLatestObservedInputVersion: () => latestObservedInputVersion,
            getNoInputTimer: () => noInputTimer,
            setNoInputTimer: (timer) => {
              noInputTimer = timer;
            },
            getNoInputCount: () => noInputCount,
            setNoInputCount: (value) => {
              noInputCount = value;
            },
            setEndingSession: (value) => {
              endingSession = value;
            }
          });

          if (committedPromptQueue.length === 0 && pendingPromptParts.length === 0 && !pendingPromptTimer) {
            break;
          }
        }
      } catch (error) {
        logger.error("Failed to process committed caller prompt", {
          callSid,
          error: String(error)
        });
        this.send(ws, {
          type: "text",
          token: "I am sorry, something went wrong while processing that. Please say that again.",
          last: true
        });
      } finally {
        processingPrompt = false;
        if (committedPromptQueue.length > 0) {
          void processCommittedPrompts(session);
        }
      }
    };

    ws.on("message", async (raw) => {
      try {
        const message = this.parseMessage(raw.toString());
        logger.debug("Conversation Relay message received", { type: message.type, callSid });

        if (this.isSetupMessage(message)) {
          const session = await this.handleSetup(message);
          callSid = session.callSid;
          if (message.customParameters?.welcomeGreetingProvided !== "true") {
            const greeting = session.officeContext?.aiGreeting ?? "Thank you for calling. How can I help you today?";
            await this.orchestrator.recordAssistantTurn(session, greeting, {
              source: "setup-greeting"
            });
            this.send(ws, {
              type: "text",
              token: greeting,
              last: true
            });
            noInputTimer = this.resetNoInputTimer(
              session,
              ws,
              greeting,
              noInputTimer,
              noInputCount,
              (value) => {
                noInputCount = value;
              },
              (timer) => {
                noInputTimer = timer;
              }
            );
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
          if (endingSession) {
            logger.info("Ignoring caller prompt because call end is in progress", {
              callSid,
              voicePrompt: message.voicePrompt
            });
            return;
          }

          logger.info("Conversation Relay prompt received", {
            callSid,
            last: message.last,
            hasVoicePrompt: typeof message.voicePrompt === "string" && message.voicePrompt.trim().length > 0,
            voicePromptLength: message.voicePrompt?.length ?? 0
          });
          noInputTimer = this.clearTimer(noInputTimer);
          noInputCount = 0;

          if (message.last !== true) {
            logger.debug("Ignoring non-final Conversation Relay prompt fragment", {
              callSid,
              last: message.last
            });
            return;
          }

          const callerText = message.voicePrompt?.trim();
          if (!callerText) {
            logger.info("Skipping empty Conversation Relay prompt", {
              callSid,
              last: message.last
            });
            return;
          }

          if (this.wasRecentlyProcessed(callerText, lastProcessedPrompt)) {
            logger.info("Skipping duplicate final prompt", { callSid, callerText });
            return;
          }

          latestObservedInputVersion += 1;
          this.addPendingPromptPart(callerText, pendingPromptParts);
          pendingPromptTimer = this.resetPendingPromptTimer(
            pendingPromptParts,
            committedPromptQueue,
            pendingPromptResolvers,
            pendingPromptTimer,
            (timer) => {
              pendingPromptTimer = timer;
            },
            () => {
              nextTurnId += 1;
              return {
                turnId: nextTurnId,
                observedInputVersion: latestObservedInputVersion
              };
            },
            () => {
              void processCommittedPrompts(session);
            }
          );
          logger.info("Caller input buffered", {
            callSid,
            callerText,
            pendingPromptCount: pendingPromptParts.length,
            latestObservedInputVersion
          });

          void processCommittedPrompts(session);

          return;
        }

        if (message.type === "interrupt") {
          if (endingSession) {
            logger.info("Caller interrupted while call end was already in progress", {
              callSid,
              utteranceUntilInterrupt: message.utteranceUntilInterrupt
            });
            return;
          }

          interruptionGeneration += 1;
          pendingPromptParts = [];
          pendingPromptTimer = this.clearTimer(pendingPromptTimer);
          noInputTimer = this.clearTimer(noInputTimer);
          this.resolvePendingPromptWaiters(pendingPromptResolvers, undefined);
          logger.info("Caller interrupted AI response", {
            callSid,
            utteranceUntilInterrupt: message.utteranceUntilInterrupt,
            interruptionGeneration
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
      pendingPromptTimer = this.clearTimer(pendingPromptTimer);
      committedPromptQueue = [];
      noInputTimer = this.clearTimer(noInputTimer);
      this.resolvePendingPromptWaiters(pendingPromptResolvers, undefined);
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

  private async processPrompt(context: PromptProcessingContext) {
    const startedAt = Date.now();
    let processing = true;
    const processingAckTimer = this.scheduleProcessingAcknowledgement(context, startedAt, () => processing);
    let outcome;
    try {
      outcome = await this.orchestrator.handleCallerText(context.session, context.callerText);
    } finally {
      processing = false;
      this.clearTimer(processingAckTimer);
    }
    if (context.expectedInterruptionGeneration !== context.getInterruptionGeneration()) {
      logger.info("AI reply suppressed as stale after interrupt", {
        callSid: context.session.callSid,
        callerText: context.callerText,
        turnId: context.turnId,
        expectedInterruptionGeneration: context.expectedInterruptionGeneration,
        interruptionGeneration: context.getInterruptionGeneration()
      });
      return {
        text: this.normalizePrompt(context.callerText),
        at: Date.now()
      };
    }
    if (context.expectedObservedInputVersion !== context.getLatestObservedInputVersion()) {
      logger.info("AI reply suppressed as stale after newer caller turn", {
        callSid: context.session.callSid,
        callerText: context.callerText,
        turnId: context.turnId,
        expectedObservedInputVersion: context.expectedObservedInputVersion,
        latestObservedInputVersion: context.getLatestObservedInputVersion()
      });
      return {
        text: this.normalizePrompt(context.callerText),
        at: Date.now()
      };
    }

    this.send(context.ws, {
      type: "text",
      token: outcome.reply,
      last: true
    });
    void this.orchestrator.recordAssistantTurn(
      context.session,
      outcome.reply,
      outcome.assistantMetadata
    );
    logger.info("AI reply sent to Conversation Relay", {
      callSid: context.session.callSid,
      turnId: context.turnId,
      durationMs: Date.now() - startedAt,
      shouldEndSession: outcome.shouldEndSession,
      shouldTransferToStaff: outcome.shouldTransferToStaff
    });

    if (outcome.shouldEndSession) {
      context.setEndingSession(true);
      context.setNoInputTimer(this.clearTimer(context.getNoInputTimer()));
      this.scheduleCallEnd(context.session, context.ws, outcome.reply, {
        turnId: context.turnId,
        shouldTransferToStaff: outcome.shouldTransferToStaff,
        handoffData: outcome.handoffData
      });
      return {
        text: this.normalizePrompt(context.callerText),
        at: Date.now()
      };
    }

    context.setNoInputTimer(this.resetNoInputTimer(
      context.session,
      context.ws,
      outcome.reply,
      context.getNoInputTimer(),
      context.getNoInputCount(),
      context.setNoInputCount,
      context.setNoInputTimer
    ));

    return {
      text: this.normalizePrompt(context.callerText),
      at: Date.now()
    };
  }

  private wasRecentlyProcessed(callerText: string, lastProcessedPrompt?: { text: string; at: number }): boolean {
    if (!lastProcessedPrompt) {
      return false;
    }

    const duplicateWindowMs = 2000;
    return lastProcessedPrompt.text === this.normalizePrompt(callerText)
      && Date.now() - lastProcessedPrompt.at <= duplicateWindowMs;
  }

  private normalizePrompt(callerText: string): string {
    return callerText.trim().replace(/\s+/g, " ").toLowerCase();
  }

  private addPendingPromptPart(callerText: string, pendingPromptParts: string[]): void {
    pendingPromptParts.push(callerText.trim());
  }

  private resetPendingPromptTimer(
    pendingPromptParts: string[],
    committedPromptQueue: CommittedPrompt[],
    pendingPromptResolvers: Array<(value: CommittedPrompt | undefined) => void>,
    existingTimer: ReturnType<typeof setTimeout> | undefined,
    setPendingPromptTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void,
    createPromptMetadata: () => Pick<CommittedPrompt, "turnId" | "observedInputVersion">,
    onCommittedPromptQueued: () => void
  ): ReturnType<typeof setTimeout> {
    this.clearTimer(existingTimer);

    return setTimeout(() => {
      setPendingPromptTimer(undefined);
      const committedPrompt = this.commitPendingPrompt(pendingPromptParts, createPromptMetadata);
      if (committedPrompt) {
        committedPromptQueue.push(committedPrompt);
      }
      if (pendingPromptResolvers.length > 0) {
        this.resolvePendingPromptWaiters(pendingPromptResolvers, committedPromptQueue.shift());
        return;
      }
      onCommittedPromptQueued();
    }, config.AI_END_OF_UTTERANCE_WINDOW_MS);
  }

  private commitPendingPrompt(
    pendingPromptParts: string[],
    createPromptMetadata: () => Pick<CommittedPrompt, "turnId" | "observedInputVersion">
  ): CommittedPrompt | undefined {
    if (pendingPromptParts.length === 0) {
      return undefined;
    }

    const committedText = pendingPromptParts
      .splice(0, pendingPromptParts.length)
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ");

    if (!committedText) {
      return undefined;
    }

    const committedPrompt = {
      ...createPromptMetadata(),
      text: committedText
    };
    logger.info("Caller turn committed", {
      turnId: committedPrompt.turnId,
      observedInputVersion: committedPrompt.observedInputVersion,
      text: committedPrompt.text
    });
    return committedPrompt;
  }

  private awaitCommittedPrompt(
    committedPromptQueue: CommittedPrompt[],
    pendingPromptResolvers: Array<(value: CommittedPrompt | undefined) => void>
  ): Promise<CommittedPrompt | undefined> {
    const queuedPrompt = committedPromptQueue.shift();
    if (queuedPrompt) {
      return Promise.resolve(queuedPrompt);
    }

    return new Promise((resolve) => {
      pendingPromptResolvers.push(resolve);
    });
  }

  private resolvePendingPromptWaiters(
    pendingPromptResolvers: Array<(value: CommittedPrompt | undefined) => void>,
    value: CommittedPrompt | undefined
  ): void {
    while (pendingPromptResolvers.length > 0) {
      const resolve = pendingPromptResolvers.shift();
      resolve?.(value);
    }
  }

  private resetNoInputTimer(
    session: CallSession,
    ws: WebSocket,
    assistantText: string,
    existingTimer: ReturnType<typeof setTimeout> | undefined,
    noInputCount: number,
    setNoInputCount: (value: number) => void,
    setNoInputTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void
  ): ReturnType<typeof setTimeout> {
    this.clearTimer(existingTimer);
    const delayMs = this.estimatedSpeechDurationMs(assistantText) + config.AI_NO_INPUT_TIMEOUT_MS;
    logger.info("No-input timer armed", {
      callSid: session.callSid,
      delayMs,
      noInputCount
    });

    return setTimeout(() => {
      setNoInputTimer(undefined);
      void this.handleNoInputTimeout(session, ws, noInputCount, setNoInputCount, setNoInputTimer);
    }, delayMs);
  }

  private async handleNoInputTimeout(
    session: CallSession,
    ws: WebSocket,
    noInputCount: number,
    setNoInputCount: (value: number) => void,
    setNoInputTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void
  ): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (noInputCount < config.AI_MAX_NO_INPUT_REPROMPTS) {
      const reprompt = noInputCount === 0
        ? "I'm still here whenever you're ready."
        : "I still haven't heard anything. If you're still there, please go ahead whenever you're ready.";
      const attempt = noInputCount + 1;
      logger.info("No-input reprompt fired", {
        callSid: session.callSid,
        attempt
      });
      setNoInputCount(attempt);
      await this.orchestrator.recordAssistantTurn(session, reprompt, {
        source: "no-input-reprompt",
        attempt
      });
      this.send(ws, {
        type: "text",
        token: reprompt,
        last: true
      });
      setNoInputTimer(this.resetNoInputTimer(session, ws, reprompt, undefined, attempt, setNoInputCount, setNoInputTimer));
      return;
    }

    const closingMessage = "I haven't heard anything, so I'll go ahead and end the call now. Thank you for calling.";
    logger.info("No-input call end fired", {
      callSid: session.callSid,
      attempts: noInputCount
    });
    await this.orchestrator.recordAssistantTurn(session, closingMessage, {
      source: "no-input-end"
    });
    this.send(ws, {
      type: "text",
      token: closingMessage,
      last: true
    });
    this.scheduleCallEnd(session, ws, closingMessage, {
      turnId: undefined,
      shouldTransferToStaff: false
    });
  }

  private clearTimer(timer?: ReturnType<typeof setTimeout>): undefined {
    if (timer) {
      clearTimeout(timer);
    }

    return undefined;
  }

  private estimatedSpeechDurationMs(text: string): number {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1500, words * 360 + 600);
  }

  private scheduleProcessingAcknowledgement(
    context: PromptProcessingContext,
    startedAt: number,
    shouldContinue: () => boolean,
    attempt = 0
  ): ReturnType<typeof setTimeout> {
    const delayMs = attempt === 0
      ? config.AI_PROCESSING_ACK_DELAY_MS
      : config.AI_PROCESSING_ACK_REPEAT_MS;

    return setTimeout(() => {
      if (!shouldContinue()
        || context.expectedInterruptionGeneration !== context.getInterruptionGeneration()
        || context.expectedObservedInputVersion !== context.getLatestObservedInputVersion()
        || context.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (attempt === 0 && config.AI_PROCESSING_SOUND_URL) {
        logger.info("Processing sound sent", {
          callSid: context.session.callSid,
          turnId: context.turnId,
          elapsedMs: Date.now() - startedAt
        });
        this.send(context.ws, {
          type: "play",
          source: config.AI_PROCESSING_SOUND_URL,
          loop: 0,
          preemptible: true,
          interruptible: true
        });
        this.scheduleProcessingAcknowledgement(context, startedAt, shouldContinue, attempt + 1);
        return;
      }

      const acknowledgement = attempt <= 1
        ? "I'm checking that now. Thanks for waiting."
        : "This is taking a little longer than usual, but I'm still checking.";
      logger.info("Processing acknowledgement sent", {
        callSid: context.session.callSid,
        turnId: context.turnId,
        attempt: attempt + 1,
        elapsedMs: Date.now() - startedAt
      });
      void this.orchestrator.recordAssistantTurn(context.session, acknowledgement, {
        source: "processing-acknowledgement",
        turnId: context.turnId,
        attempt: attempt + 1
      });
      this.send(context.ws, {
        type: "text",
        token: acknowledgement,
        last: true
      });
      this.scheduleProcessingAcknowledgement(context, startedAt, shouldContinue, attempt + 1);
    }, delayMs);
  }

  private scheduleCallEnd(
    session: CallSession,
    ws: WebSocket,
    assistantText: string,
    options: {
      turnId?: number;
      shouldTransferToStaff: boolean;
      handoffData?: Record<string, unknown>;
    }
  ): void {
    const delayMs = this.estimatedSpeechDurationMs(assistantText) + 500;
    logger.info("AI call end scheduled", {
      callSid: session.callSid,
      turnId: options.turnId,
      delayMs,
      shouldTransferToStaff: options.shouldTransferToStaff
    });

    windowlessDelay(() => {
      const response: ConversationRelayResponse = options.shouldTransferToStaff
        ? {
          type: "end",
          handoffData: JSON.stringify(options.handoffData ?? {})
        }
        : {
          type: "end"
        };
      const sent = this.send(ws, response);
      logger.info("AI call end sent to Conversation Relay", {
        callSid: session.callSid,
        turnId: options.turnId,
        sent,
        shouldTransferToStaff: options.shouldTransferToStaff
      });

      if (!options.shouldTransferToStaff) {
        windowlessDelay(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, "AI call ended");
          }
        }, 500);
      }
    }, delayMs);
  }

  private send(ws: WebSocket, response: ConversationRelayResponse): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    ws.send(JSON.stringify(response));
    return true;
  }
}

function windowlessDelay(callback: () => void, milliseconds: number): void {
  setTimeout(callback, milliseconds);
}
