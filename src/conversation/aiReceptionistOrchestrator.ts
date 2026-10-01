import { SpringBootClient } from "../backend/springBootClient.js";
import { CallSession, CallSessionStore, TranscriptTurn } from "../calls/callSession.js";
import { OfficeContextCache } from "../calls/officeContextCache.js";
import { config } from "../config/env.js";
import { ToolExecutor } from "../tools/toolExecutor.js";
import { logger } from "../utils/logger.js";
import { ConversationWorkflowRegistry } from "../workflows/shared/workflowRegistry.js";
import { extractWorkflowEnvelope } from "../workflows/workflowState.js";
import { ModelClient, ModelTurnResult } from "./modelClient.js";
import {
  assistantTextOffersStaffTransfer,
  callerActionExplicitlyAuthorizesStaffTransfer,
  callerActionDeclinesStaffTransfer,
  callerTextAsksOfficeHours,
  callerExplicitlyEndsCall,
  callerDeclinesFurtherAssistance,
  callerTextRequestsStaffTransfer,
} from "../workflows/shared/callerActionDecision.js";

const COMPLETE_CALL_MAX_ATTEMPTS = 3;
const COMPLETE_CALL_RETRY_DELAY_MS = 250;

export interface ConversationTurnOutcome {
  reply: string;
  assistantMetadata?: Record<string, unknown>;
  shouldEndSession: boolean;
  shouldTransferToStaff: boolean;
  handoffData?: Record<string, unknown>;
}

export class AiReceptionistOrchestrator {
  private readonly springBootClient = new SpringBootClient();
  private readonly toolExecutor = new ToolExecutor(this.springBootClient);
  private readonly modelClient = new ModelClient();
  private readonly bookingAppointmentTypeResolution = {
    selectAppointmentType: (session: CallSession, reason?: string) => (
      this.modelClient.selectBookingAppointmentType(session, reason)
    ),
    bookingResponse: (session: CallSession, purpose: "APPOINTMENT_TYPE_CLARIFICATION" | "SCHEDULING_PREFERENCE") => (
      this.modelClient.bookingResponse(session, purpose)
    )
  };
  private readonly workflowRegistry = new ConversationWorkflowRegistry(this.bookingAppointmentTypeResolution);
  private readonly officeContextCache = new OfficeContextCache({
    ttlMs: config.AI_OFFICE_CONTEXT_CACHE_TTL_MS,
    maxEntries: config.AI_OFFICE_CONTEXT_CACHE_MAX_ENTRIES
  });

  constructor(private readonly sessions: CallSessionStore) {}

  async initializeSession(input: {
    callSid: string;
    accountSid?: string;
    officeCode: string;
    fromNumber?: string;
    toNumber?: string;
  }): Promise<CallSession> {
    const session = this.sessions.create(input);
    session.officeContext = await this.officeContextCache.getOrLoad(
      input.officeCode,
      () => this.springBootClient.getOfficeContext(input.officeCode, input.callSid)
    );
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

  async handleCallerText(
    session: CallSession,
    callerText: string,
    options: { recordCallerTurn?: boolean } = {}
  ): Promise<ConversationTurnOutcome> {
    try {
      return await this.processCallerText(session, callerText, options);
    } catch (error) {
      const workflowError = this.workflowRegistry.handleError(session, error);
      if (!workflowError) throw error;
      return this.offerStaffTransfer(session, workflowError.staffTransferReason);
    }
  }

  private async directStaffTransfer(session: CallSession): Promise<ConversationTurnOutcome> {
    delete session.pendingActions.TRANSFER_TO_STAFF;
    const toolRequest = { name: "TRANSFER_TO_STAFF", arguments: {} } as const;
    const toolResult = await this.tryExecuteTool(session, toolRequest);
    session.lastToolResults[toolRequest.name] = toolResult;
    session.workflowState = extractWorkflowEnvelope(toolResult) ?? session.workflowState;
    this.sessions.append(session, {
      speaker: "tool",
      text: JSON.stringify(toolResult),
      metadata: { toolName: toolRequest.name, source: "deterministic-caller-request" }
    });

    return {
      reply: "I will connect you with our office staff now.",
      shouldEndSession: true,
      shouldTransferToStaff: true,
      assistantMetadata: { intent: "TRANSFER_TO_STAFF", source: "deterministic-caller-request" },
      handoffData: {
        reasonCode: "live-agent-handoff",
        reason: "Caller explicitly requested office staff.",
        officeCode: session.officeCode,
        callSid: session.callSid,
        fromNumber: session.fromNumber,
        toNumber: session.toNumber,
        intent: "TRANSFER_TO_STAFF",
        collectedFields: session.collectedFields,
        workflowState: session.workflowState
      }
    };
  }

  private offerStaffTransfer(session: CallSession, reason: string): ConversationTurnOutcome {
    session.pendingActions.TRANSFER_TO_STAFF = {
      status: "AWAITING_CALLER_CONFIRMATION",
      reason,
      createdAt: new Date().toISOString()
    };
    return {
      reply: "I can connect you with our office staff. Would you like me to transfer you now?",
      shouldEndSession: false,
      shouldTransferToStaff: false,
      assistantMetadata: { intent: "TRANSFER_TO_STAFF", source: "transfer-confirmation" }
    };
  }

  private async processCallerText(
    session: CallSession,
    callerText: string,
    options: { recordCallerTurn?: boolean } = {}
  ): Promise<ConversationTurnOutcome> {
    const turnStartedAt = Date.now();
    if (options.recordCallerTurn !== false) {
      await this.recordCallerTurn(session, callerText);
    }

    const firstModelStartedAt = Date.now();
    if (callerExplicitlyEndsCall(callerText)) {
      const reply = "Understood. I will end the call now. Thank you for calling.";
      return {
        reply,
        assistantMetadata: { intent: "GOODBYE", source: "deterministic-caller-end" },
        shouldEndSession: true,
        shouldTransferToStaff: false
      };
    }

    if (session.pendingActions.TRANSFER_TO_STAFF) {
      let transferDecision: ModelTurnResult | undefined;
      try {
        transferDecision = await this.modelClient.nextTurn(session, callerText);
      } catch (error) {
        logger.warn("Unable to interpret caller's transfer confirmation; keeping transfer pending", {
          callSid: session.callSid,
          officeCode: session.officeCode,
          error: String(error)
        });
      }
      if (session.pendingActions.TRANSFER_TO_STAFF.status === "AWAITING_CALLER_CONFIRMATION"
        && callerActionExplicitlyAuthorizesStaffTransfer(transferDecision)) {
        return this.directStaffTransfer(session);
      }
      if (callerActionDeclinesStaffTransfer(transferDecision)) {
        delete session.pendingActions.TRANSFER_TO_STAFF;
        return {
          reply: "Okay, I won't transfer you. How else may I help?",
          assistantMetadata: { intent: session.currentIntent ?? "UNKNOWN", source: "transfer-declined" },
          shouldEndSession: false,
          shouldTransferToStaff: false
        };
      }
      return {
        reply: "Would you like me to transfer you to our office staff? Please say yes or no.",
        assistantMetadata: { intent: "TRANSFER_TO_STAFF", source: "transfer-confirmation" },
        shouldEndSession: false,
        shouldTransferToStaff: false
      };
    }

    const previousAssistantTextForClosing = [...session.transcript].reverse()
      .find((turn) => turn.speaker === "assistant")?.text ?? "";
    if (callerDeclinesFurtherAssistance(callerText, previousAssistantTextForClosing)) {
      return {
        reply: "Thank you for calling. Have a great day!",
        assistantMetadata: { intent: "GOODBYE", source: "caller-declined-further-assistance" },
        shouldEndSession: true,
        shouldTransferToStaff: false
      };
    }

    if (callerTextRequestsStaffTransfer(callerText)) {
      return this.directStaffTransfer(session);
    }

    if (callerTextAsksOfficeHours(callerText)) {
      return {
        reply: session.officeContext?.businessHoursSummary
          ? `${session.officeContext.businessHoursSummary} Would you like me to help schedule a visit?`
          : "I can help you schedule a visit. Would you like to choose a day and time?",
        assistantMetadata: { intent: "OFFICE_INFORMATION", source: "deterministic-office-hours-question" },
        shouldEndSession: false,
        shouldTransferToStaff: false
      };
    }

    const workflowCallerDecision = this.workflowRegistry.handleCallerTurn(session, callerText);
    if (workflowCallerDecision) {
      return {
        reply: workflowCallerDecision.reply,
        assistantMetadata: { intent: "BOOK_APPOINTMENT", source: workflowCallerDecision.source },
        shouldEndSession: false,
        shouldTransferToStaff: false
      };
    }

    let firstResult = await this.modelClient.nextTurn(session, callerText);
    firstResult = this.workflowRegistry.prepareModelResult(session, callerText, firstResult);
    const bookingEntryDecision = this.workflowRegistry.handleBookingEntry(session, callerText, firstResult);
    if (bookingEntryDecision) {
      return {
        reply: bookingEntryDecision.reply,
        assistantMetadata: { intent: "BOOK_APPOINTMENT", source: bookingEntryDecision.source },
        shouldEndSession: false,
        shouldTransferToStaff: false
      };
    }
    const firstModelDurationMs = Date.now() - firstModelStartedAt;
    logger.info("AI first model result received", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      currentIntent: session.currentIntent,
      requestedToolName: firstResult.toolRequest?.name,
      hasCollectedFieldsUpdate: !!firstResult.collectedFields,
      workflowStatePresent: !!session.workflowState,
      workflowStateSummary: this.workflowStateSummary(session)
    });

    // Make same-turn model output available while resolving prerequisite tools.
    if (firstResult.intent) {
      session.currentIntent = firstResult.intent;
    }
    this.workflowRegistry.constrainModelResult(session, firstResult);
    if (firstResult.collectedFields) {
      session.collectedFields = {
        ...session.collectedFields,
        ...firstResult.collectedFields
      };
    }
    this.workflowRegistry.synchronizeModelData(session, firstResult, callerText);
    this.workflowRegistry.hydrateContext(session);
    this.workflowRegistry.synchronizeModelResult(session, firstResult);

    const finalResult = await this.resolvePolicyAwareModelResult(session, firstResult);
    if (firstResult.toolRequest
      && firstResult.intent
      && !this.isTerminalIntent(finalResult.intent)) {
      finalResult.intent = firstResult.intent;
    }
    const reply = this.workflowRegistry.prepareReply(
      session,
      finalResult.reply ?? "I am sorry, I could not complete that request."
    );
    const transferToStaff = false;
    const transferOffer = assistantTextOffersStaffTransfer(reply);
    // A model flag is not evidence that the caller ended the conversation.
    // Explicit caller goodbyes and confirmed staff transfers return above.
    const shouldEndSession = false;
    if (transferOffer) {
      session.pendingActions.TRANSFER_TO_STAFF = {
        status: "AWAITING_CALLER_CONFIRMATION",
        reason: "assistant-offered-transfer",
        createdAt: new Date().toISOString()
      };
    }

    logger.info("AI turn completed", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      currentIntent: session.currentIntent,
      finalIntent: finalResult.intent,
      shouldEndSession,
      shouldTransferToStaff: transferToStaff,
      workflowStateSummary: this.workflowStateSummary(session),
      modelMarkedEndCall: finalResult.shouldEndCall === true,
      firstModelDurationMs,
      totalDurationMs: Date.now() - turnStartedAt
    });

    if (finalResult.intent) {
      session.currentIntent = finalResult.intent;
    }
    this.workflowRegistry.constrainModelResult(session, finalResult);
    if (finalResult.collectedFields) {
      session.collectedFields = {
        ...session.collectedFields,
        ...finalResult.collectedFields
      };
    }
    this.workflowRegistry.synchronizeModelData(session, finalResult);

    return {
      reply,
      assistantMetadata: {
        intent: finalResult.intent
      },
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
        collectedFields: session.collectedFields,
        workflowState: session.workflowState
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
      workflowState: session.workflowState,
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
  }

  private async resolveModelResult(
    session: CallSession,
    result: ModelTurnResult,
    bookingFollowups = 0,
    toolChainDepth = 0
  ): Promise<ModelTurnResult> {
    this.workflowRegistry.constrainModelResult(session, result);
    if (!result.toolRequest) {
      return result;
    }

    const callerSelectedAvailableSlot = this.workflowRegistry.callerSelectedAvailableSlot(session, result);

    if (result.toolRequest.name === "TRANSFER_TO_STAFF") {
      return this.offerStaffTransfer(session, "model-or-workflow-request");
    }

    result = await this.workflowRegistry.prepareToolRequest(session, result);
    if (!result.toolRequest) {
      return result;
    }

    const toolChainLimit = this.workflowRegistry.limitToolChain(session, result, toolChainDepth);
    if (toolChainLimit) {
      return toolChainLimit;
    }

    this.workflowRegistry.synchronizeModelResult(session, result);

    const toolStartedAt = Date.now();
    logger.info("AI tool request started", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      toolName: result.toolRequest.name,
      arguments: result.toolRequest.arguments
    });
    const toolResult = await this.tryExecuteTool(session, result.toolRequest);
    session.lastToolResults[result.toolRequest.name] = toolResult;
    session.workflowState = extractWorkflowEnvelope(toolResult) ?? session.workflowState;
    const workflowToolResultContext = this.workflowRegistry.synchronizeToolResult(
      session,
      result.toolRequest.name,
      toolResult,
      session.currentIntent,
      result,
      { callerSelectedAvailableSlot }
    );
    this.workflowRegistry.synchronizeModelResult(session, result);
    this.workflowRegistry.invalidateToolResultCache(session, result.toolRequest.name, toolResult);
    this.workflowRegistry.consumeToolResult(session, result.toolRequest.name, toolResult);
    logger.info("AI workflow state updated from tool result", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      toolName: result.toolRequest.name,
      workflowStateSummary: this.workflowStateSummary(session),
      selectedAppointmentId: this.selectedAppointmentId(session),
      availableAppointmentCount: this.availableAppointmentCount(session)
    });
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
      ok: typeof toolResult === "object" && toolResult !== null && "ok" in toolResult ? (toolResult as { ok?: unknown }).ok : undefined,
      durationMs: Date.now() - toolStartedAt
    });

    // A staff transfer is terminal for this caller turn. Do not ask the model
    // to interpret the transfer result and then allow it to request the same
    // transfer again indefinitely while the Relay connection is still open.
    if (result.toolRequest.name === "TRANSFER_TO_STAFF") {
      return {
        ...result,
        intent: "TRANSFER_TO_STAFF",
        toolRequest: undefined,
        shouldEndCall: true,
        reply: result.reply?.trim() || "I'll connect you with our office staff now."
      };
    }

    const workflowToolResult = await this.workflowRegistry.resolveToolResult(
      session,
      result,
      toolResult,
      workflowToolResultContext
    );
    if (workflowToolResult) {
      return workflowToolResult.toolRequest
        ? this.resolveModelResult(session, workflowToolResult, bookingFollowups, toolChainDepth + 1)
        : workflowToolResult;
    }

    const toolPolicyDecision = this.workflowRegistry.applyWorkflowToolResultPolicies(
      session,
      result.toolRequest.name,
      toolResult,
      result
    );
    if (toolPolicyDecision?.overrideResult) {
      return this.resolveModelResult(session, toolPolicyDecision.overrideResult, bookingFollowups, toolChainDepth + 1);
    }
    if (toolPolicyDecision?.repromptContext) {
      return this.continueFromPolicyReprompt(
        session,
        toolPolicyDecision.instruction
          ?? "A workflow verification boundary is active. Continue the active workflow using the provided boundary context.",
        toolPolicyDecision.repromptContext
      );
    }

    const followupModelStartedAt = Date.now();
    const finalResult = await this.modelClient.continueWithToolResult(session, toolResult);
    logger.info("AI tool result response completed", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      toolName: result.toolRequest.name,
      replyIntent: finalResult.intent,
      requestedToolName: finalResult.toolRequest?.name,
      workflowStateSummary: this.workflowStateSummary(session),
      durationMs: Date.now() - followupModelStartedAt
    });
    const workflowFollowup = await this.workflowRegistry.prepareFollowup(
      session,
      finalResult,
      bookingFollowups,
      result.toolRequest.name
    );
    if (workflowFollowup) {
      return workflowFollowup.disposition === "CONTINUE_TOOL_CHAIN"
        ? this.resolveModelResult(session, workflowFollowup.result, bookingFollowups + 1)
        : workflowFollowup.result;
    }
    return this.resolvePolicyAwareModelResult(session, finalResult, bookingFollowups, toolChainDepth + 1);
  }

  private async resolvePolicyAwareModelResult(
    session: CallSession,
    firstResult: ModelTurnResult,
    bookingFollowups = 0,
    toolChainDepth = 0
  ): Promise<ModelTurnResult> {
    const policyDecision = this.workflowRegistry.applyWorkflowTurnPolicies(session, firstResult) ?? {
      overrideResult: firstResult
    };

    if (policyDecision.repromptContext) {
      const workflowResponse = await this.workflowRegistry.resolvePolicyReprompt(
        session,
        policyDecision.repromptContext
      );
      if (workflowResponse) {
        return workflowResponse;
      }
      return this.continueFromPolicyReprompt(
        session,
        policyDecision.instruction
          ?? "A workflow execution boundary is active. Continue the active workflow using the provided boundary context. Do not use fallback staff transfer or follow-up unless the caller explicitly asks for staff or the backend requires handoff.",
        policyDecision.repromptContext
      );
    }

    return this.resolveModelResult(
      session,
      policyDecision.overrideResult ?? firstResult,
      bookingFollowups,
      toolChainDepth
    );
  }

  async recordCallerTurn(session: CallSession, text: string): Promise<void> {
    this.sessions.append(session, {
      speaker: "patient",
      text
    });
  }

  private async continueFromPolicyReprompt(
    session: CallSession,
    instruction: string,
    boundaryContext?: Parameters<ModelClient["continueWithPolicyInstruction"]>[2]
  ): Promise<ModelTurnResult> {
    const repromptStartedAt = Date.now();
    logger.info("AI policy reprompt started", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      currentIntent: session.currentIntent,
      boundaryContextType: boundaryContext?.type,
      workflowStateSummary: this.workflowStateSummary(session)
    });
    const repromptResult = await this.modelClient.continueWithPolicyInstruction(session, instruction, boundaryContext);
    logger.info("AI policy reprompt completed", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      currentIntent: session.currentIntent,
      boundaryContextType: boundaryContext?.type,
      requestedToolName: repromptResult.toolRequest?.name,
      durationMs: Date.now() - repromptStartedAt
    });

    if (repromptResult.intent) {
      session.currentIntent = repromptResult.intent;
    }
    this.workflowRegistry.constrainModelResult(session, repromptResult);
    if (repromptResult.collectedFields) {
      session.collectedFields = {
        ...session.collectedFields,
        ...repromptResult.collectedFields
      };
    }
    this.workflowRegistry.synchronizeModelData(session, repromptResult);

    this.workflowRegistry.hydrateContext(session);
    this.workflowRegistry.synchronizeModelResult(session, repromptResult);

    if (!repromptResult.toolRequest
      && !this.workflowRegistry.shouldContinuePolicyReprompt(session, repromptResult)) {
      return repromptResult;
    }

    return this.resolvePolicyAwareModelResult(session, repromptResult);
  }

  private isTerminalIntent(intent: string | undefined): boolean {
    return intent === "TRANSFER_TO_STAFF" || intent === "HANDOFF_TO_STAFF";
  }

  private async tryExecuteTool(session: CallSession, toolRequest: NonNullable<ModelTurnResult["toolRequest"]>) {
    try {
      return await this.toolExecutor.execute(session, toolRequest);
    } catch (error) {
      logger.warn("Unable to execute AI tool; continuing with failure result", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        toolName: toolRequest.name,
        workflowStateSummary: this.workflowStateSummary(session),
        error: String(error)
      });
      return {
        name: toolRequest.name,
        ok: false,
        error: "The office system is unavailable for that request right now. Transfer to office staff."
      };
    }
  }

  private async tryCompleteCall(input: {
    callSid: string;
    officeCode: string;
    transcript: TranscriptTurn[];
    collectedFields: Record<string, unknown>;
    lastToolResults: Record<string, unknown>;
    workflowState: CallSession["workflowState"];
    summary?: Awaited<ReturnType<ModelClient["summarizeCall"]>>;
  }): Promise<void> {
    for (let attempt = 1; attempt <= COMPLETE_CALL_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.springBootClient.completeCall(input);
        return;
      } catch (error) {
        if (attempt === COMPLETE_CALL_MAX_ATTEMPTS) {
          logger.error("Unable to complete AI call record after retries", {
            callSid: input.callSid,
            officeCode: input.officeCode,
            attempts: attempt,
            error: String(error)
          });
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, COMPLETE_CALL_RETRY_DELAY_MS * attempt));
        logger.warn("Retrying AI call completion", {
          callSid: input.callSid,
          officeCode: input.officeCode,
          attempt: attempt + 1,
          error: String(error)
        });
      }
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

  private workflowStateSummary(session: CallSession): Record<string, unknown> | undefined {
    if (!session.workflowState) {
      return undefined;
    }

    return {
      workflow: session.workflowState.workflow,
      state: session.workflowState.state,
      requiredField: session.workflowState.requiredField,
      allowedActions: session.workflowState.allowedActions,
      failureReason: session.workflowState.failureReason
    };
  }

  private selectedAppointmentId(session: CallSession): unknown {
    return session.workflowState?.context?.selectedAppointmentId;
  }

  private availableAppointmentCount(session: CallSession): number | undefined {
    const appointments = session.workflowState?.context?.appointments;
    return Array.isArray(appointments) ? appointments.length : undefined;
  }

}

function isSuccessfulToolResult(toolResult: unknown): boolean {
  return !!toolResult
    && typeof toolResult === "object"
    && "ok" in toolResult
    && (toolResult as { ok?: unknown }).ok === true;
}
