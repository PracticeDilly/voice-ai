import { SpringBootClient } from "../backend/springBootClient.js";
import { CallSession, CallSessionStore } from "../calls/callSession.js";
import { invalidateAppointmentLookupCacheAfterConfirmation } from "../appointments/appointmentLookupCache.js";
import {
  consumeConfirmAppointmentPendingAction,
  hydrateConfirmAppointmentSelections,
  promoteConfirmAppointmentPendingAction,
  syncConfirmAppointmentFromLookup
} from "../workflows/confirmAppointment/confirmAppointmentPendingAction.js";
import { ToolExecutor } from "../tools/toolExecutor.js";
import { logger } from "../utils/logger.js";
import { applyWorkflowToolResultPolicies, applyWorkflowTurnPolicies } from "../workflows/shared/workflowRegistry.js";
import { extractWorkflowEnvelope } from "../workflows/workflowState.js";
import { ModelClient, ModelTurnResult } from "./modelClient.js";
import { BookingWorkflowError } from "../workflows/bookAppointment/bookingModelContract.js";
import { prepareBookingFollowup } from "../workflows/bookAppointment/bookingFollowup.js";
import { callerActionRequestsStaffTransfer } from "../workflows/shared/callerActionDecision.js";

const MAX_PATIENT_VERIFICATION_TOOL_CHAIN_DEPTH = 3;

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

  async handleCallerText(
    session: CallSession,
    callerText: string,
    options: { recordCallerTurn?: boolean } = {}
  ): Promise<ConversationTurnOutcome> {
    try {
      return await this.processCallerText(session, callerText, options);
    } catch (error) {
      if (!(error instanceof BookingWorkflowError)) throw error;
      return this.bookingHandoff(session, error);
    }
  }

  private async bookingHandoff(session: CallSession, error: BookingWorkflowError): Promise<ConversationTurnOutcome> {
    logger.warn("Booking execution stopped; transferring to staff", { callSid: session.callSid, reason: error.message });
    const reply = (await this.modelClient.bookingResponse(session, "HANDOFF")).reply!;
    return {
      reply,
      shouldEndSession: true,
      shouldTransferToStaff: true,
      assistantMetadata: { intent: "TRANSFER_TO_STAFF" },
      handoffData: { reasonCode: "booking-workflow-failure", officeCode: session.officeCode, callSid: session.callSid }
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
    const firstResult = await this.modelClient.nextTurn(session, callerText);
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
    if (firstResult.collectedFields) {
      session.collectedFields = {
        ...session.collectedFields,
        ...firstResult.collectedFields
      };
    }
    hydrateConfirmAppointmentSelections(session);
    promoteConfirmAppointmentPendingAction(session, firstResult);

    const finalResult = await this.resolvePolicyAwareModelResult(session, firstResult);
    if (firstResult.toolRequest
      && firstResult.intent
      && !this.isTerminalIntent(finalResult.intent)) {
      finalResult.intent = firstResult.intent;
    }
    const reply = finalResult.reply ?? "I am sorry, I could not complete that request.";
    const transferToStaff = this.shouldTransferToStaff(session, firstResult, finalResult);
    const shouldEndSession = transferToStaff || finalResult.shouldEndCall === true;

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
    if (finalResult.collectedFields) {
      session.collectedFields = {
        ...session.collectedFields,
        ...finalResult.collectedFields
      };
    }

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
    await this.trySaveTranscriptTurn({
      callSid: session.callSid,
      officeCode: session.officeCode,
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
    if (!result.toolRequest) {
      return result;
    }

    if (result.toolRequest.name === "VERIFY_PATIENT"
      && toolChainDepth >= MAX_PATIENT_VERIFICATION_TOOL_CHAIN_DEPTH) {
      logger.warn("Patient verification tool chain limit reached", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        toolChainDepth,
        workflowStateSummary: this.workflowStateSummary(session)
      });
      return {
        ...result,
        intent: session.currentIntent ?? result.intent,
        reply: "I'm still unable to verify your information. Would you like me to connect you with our office staff?",
        toolRequest: undefined,
        shouldEndCall: false
      };
    }

    promoteConfirmAppointmentPendingAction(session, result);

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
    syncConfirmAppointmentFromLookup(session, result.toolRequest.name, toolResult, session.currentIntent);
    promoteConfirmAppointmentPendingAction(session, result);
    invalidateAppointmentLookupCacheAfterConfirmation(session, result.toolRequest.name, toolResult);
    consumeConfirmAppointmentPendingAction(session, result.toolRequest.name, toolResult);
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

    const toolPolicyDecision = applyWorkflowToolResultPolicies(session, result.toolRequest.name, toolResult);
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

    if (result.toolRequest.name === "BOOK_APPOINTMENT" && session.workflowState?.state === "REQUIRES_CONFIRMATION") {
      return this.modelClient.bookingResponse(session, "AWAITING_CONFIRMATION");
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
    if (result.toolRequest.name === "BOOK_APPOINTMENT") {
      return this.resolveBookingFollowup(session, finalResult, bookingFollowups);
    }
    return this.resolvePolicyAwareModelResult(session, finalResult, bookingFollowups, toolChainDepth + 1);
  }

  private async resolveBookingFollowup(
    session: CallSession, result: ModelTurnResult, followups: number
  ): Promise<ModelTurnResult> {
    result = prepareBookingFollowup(session, result, followups);
    if (result.collectedFields) {
      session.collectedFields = { ...session.collectedFields, ...result.collectedFields };
    }
    if (!result.toolRequest || result.toolRequest.name === "TRANSFER_TO_STAFF") return result;
    logger.info("Executing booking follow-up tool", { callSid: session.callSid, state: session.workflowState?.state, followups: followups + 1 });
    return this.resolveModelResult(session, result, followups + 1);
  }

  private async resolvePolicyAwareModelResult(
    session: CallSession,
    firstResult: ModelTurnResult,
    bookingFollowups = 0,
    toolChainDepth = 0
  ): Promise<ModelTurnResult> {
    const policyDecision = applyWorkflowTurnPolicies(session, firstResult) ?? {
      overrideResult: firstResult
    };

    if (policyDecision.repromptContext?.type === "BOOKING_CONFIRMATION") {
      return this.modelClient.bookingResponse(session, "AWAITING_CONFIRMATION");
    }
    if (policyDecision.repromptContext) {
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
    await this.trySaveTranscriptTurn({
      callSid: session.callSid,
      officeCode: session.officeCode,
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
    if (repromptResult.collectedFields) {
      session.collectedFields = {
        ...session.collectedFields,
        ...repromptResult.collectedFields
      };
    }

    hydrateConfirmAppointmentSelections(session);
    promoteConfirmAppointmentPendingAction(session, repromptResult);

    if (!repromptResult.toolRequest && session.pendingActions.CONFIRM_APPOINTMENT?.status !== "READY_TO_EXECUTE") {
      return repromptResult;
    }

    return this.resolvePolicyAwareModelResult(session, repromptResult);
  }

  private shouldTransferToStaff(
    session: CallSession,
    firstResult: ModelTurnResult,
    finalResult: ModelTurnResult
  ): boolean {
    if (finalResult.toolRequest?.name === "TRANSFER_TO_STAFF"
      || finalResult.intent === "TRANSFER_TO_STAFF") {
      return true;
    }

    if (firstResult.toolRequest?.name !== "TRANSFER_TO_STAFF") {
      return false;
    }

    const verificationBoundary = session.workflowState?.workflow === "PATIENT_VERIFICATION"
      && ["FAILED", "HANDOFF_REQUIRED", "NEEDS_NEW_PATIENT_CONFIRMATION"].includes(session.workflowState.state);
    return !verificationBoundary || callerActionRequestsStaffTransfer(firstResult);
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
    workflowState: CallSession["workflowState"];
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
