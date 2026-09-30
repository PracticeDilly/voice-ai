import { SpringBootClient } from "../backend/springBootClient.js";
import { CallSession, CallSessionStore, TranscriptTurn } from "../calls/callSession.js";
import { OfficeContextCache } from "../calls/officeContextCache.js";
import { config } from "../config/env.js";
import { invalidateAppointmentLookupCacheAfterConfirmation } from "../appointments/appointmentLookupCache.js";
import {
  consumeConfirmAppointmentPendingAction,
  hydrateConfirmAppointmentSelections,
  promoteConfirmAppointmentPendingAction,
  syncConfirmAppointmentFromLookup
} from "../workflows/confirmAppointment/confirmAppointmentPendingAction.js";
import { selectedConfirmAppointmentOption } from "../workflows/confirmAppointment/confirmAppointmentSelectionStore.js";
import { ToolExecutor } from "../tools/toolExecutor.js";
import { logger } from "../utils/logger.js";
import { applyWorkflowToolResultPolicies, applyWorkflowTurnPolicies } from "../workflows/shared/workflowRegistry.js";
import { extractWorkflowEnvelope } from "../workflows/workflowState.js";
import { ModelClient, ModelTurnResult } from "./modelClient.js";
import { BookingWorkflowError } from "../workflows/bookAppointment/bookingModelContract.js";
import { prepareBookingFollowup } from "../workflows/bookAppointment/bookingFollowup.js";
import { bookingReason, isEligibleAppointmentTypeId } from "../workflows/bookAppointment/appointmentTypeSelection.js";
import {
  assistantTextOffersStaffTransfer,
  callerTextConfirmsStaffTransfer,
  callerTextDeclinesStaffTransfer,
  callerTextAsksOfficeHours,
  callerExplicitlyEndsCall,
  callerDeclinesFurtherAssistance,
  callerTextRequestsStaffTransfer,
  callerTextExplicitlyContinuesAsNewPatient
} from "../workflows/shared/callerActionDecision.js";
import { addDaysToBookingDate, correctBookingRelativeDateMentions, correctBookingWeekdayMentions } from "../workflows/bookAppointment/bookingDatePreference.js";
import { bookingPatientChoiceFromSpeech } from "../workflows/bookAppointment/bookingPatientChoice.js";
import {
  constrainNewPatientDataUpdates,
  markNewPatientConfirmationPrompt,
  newPatientConfirmationQuestion,
  synchronizeNewPatientDataConfirmation
} from "../workflows/shared/newPatientDataConfirmation.js";

const MAX_PATIENT_VERIFICATION_TOOL_CHAIN_DEPTH = 3;
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
      if (!(error instanceof BookingWorkflowError)) throw error;
      return this.bookingHandoff(session, error);
    }
  }

  private async bookingHandoff(session: CallSession, error: BookingWorkflowError): Promise<ConversationTurnOutcome> {
    logger.warn("Booking execution requires staff handoff confirmation", { callSid: session.callSid, reason: error.message });
    return this.offerStaffTransfer(session, "booking-workflow-failure");
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

  private startNewPatientBooking(session: CallSession): void {
    session.bookingPatientChoice = "NEW_PATIENT";
    session.awaitingBookingPatientChoice = false;
    session.currentIntent = "BOOK_APPOINTMENT";
    session.newPatientBookingCandidate = true;
    session.newPatientDataConfirmation = { confirmed: {} };
    session.collectedFields.continueAsNewPatient = true;
    if (session.fromNumber && !session.collectedFields.patientPhone) {
      session.collectedFields.patientPhone = session.fromNumber;
    }
    session.workflowState = {
      contractVersion: 1,
      workflow: "BOOK_APPOINTMENT",
      state: "NEEDS_NEW_PATIENT_DATA",
      requiredField: "firstName",
      allowedActions: ["BOOK_APPOINTMENT"],
      context: { patientType: "NEW_PATIENT", patientVerified: false, canDisclosePatientData: false },
      failureReason: null
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
      if (callerTextConfirmsStaffTransfer(callerText)) {
        return this.directStaffTransfer(session);
      }
      if (callerTextDeclinesStaffTransfer(callerText)) {
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
      return this.offerStaffTransfer(session, "caller-request");
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

    if (session.awaitingBookingPatientChoice) {
      const choice = bookingPatientChoiceFromSpeech(callerText);
      if (!choice) {
        return {
          reply: "For this appointment, is the patient new to our office or have they visited before?",
          assistantMetadata: { intent: "BOOK_APPOINTMENT", source: "patient-status-clarification" },
          shouldEndSession: false,
          shouldTransferToStaff: false
        };
      }
      session.awaitingBookingPatientChoice = false;
      session.bookingPatientChoice = choice;
      if (choice === "NEW_PATIENT") {
        this.startNewPatientBooking(session);
      }
      if (/^(?:(?:i am|i'm|we are)\s+)?(?:a\s+|an\s+)?(?:new|existing|returning|current|first[- ]time)\s+patient[.!?]*$/i.test(callerText.trim())) {
        return {
          reply: choice === "NEW_PATIENT"
            ? "Great. What is the patient's first name?"
            : "Thanks. Please say and spell the patient's first name so I can find the right record.",
          assistantMetadata: { intent: "BOOK_APPOINTMENT", source: "patient-status-choice" },
          shouldEndSession: false,
          shouldTransferToStaff: false
        };
      }
    }

    let firstResult = await this.modelClient.nextTurn(session, callerText);
    firstResult = this.applyDeterministicCallerAuthorization(session, callerText, firstResult);
    const previousAssistantText = [...session.transcript].reverse()
      .find((turn) => turn.speaker === "assistant")?.text ?? "";
    if (session.workflowState?.workflow === "BOOK_APPOINTMENT"
      && session.workflowState.state === "NEEDS_SCHEDULING_PREFERENCE"
      && session.lastBookingSearchRange
      && /\b(?:next|earliest|first) available\b/i.test(previousAssistantText)
      && /^(?:yes|yeah|yep|sure|please|go ahead|okay|ok)[\s,.!?]*$/i.test(callerText.trim())) {
      const fromDate = addDaysToBookingDate(session.lastBookingSearchRange.toDate, 1);
      const toDate = addDaysToBookingDate(fromDate, 7);
      if (fromDate && toDate) {
        firstResult = {
          intent: "BOOK_APPOINTMENT",
          toolRequest: {
            name: "BOOK_APPOINTMENT",
            arguments: {
              ...session.collectedFields,
              datePreference: fromDate,
              fromDate,
              toDate,
              callerConfirmedBooking: false
            }
          }
        };
      }
    }
    if (firstResult.intent?.trim().toUpperCase() === "BOOK_APPOINTMENT"
      && session.fromNumber
      && !session.workflowState
      && !session.bookingPatientChoice) {
      session.currentIntent = "BOOK_APPOINTMENT";
      session.collectedFields = { ...session.collectedFields, ...(firstResult.collectedFields ?? {}) };
      const choice = bookingPatientChoiceFromSpeech(callerText);
      if (choice === "NEW_PATIENT") {
        this.startNewPatientBooking(session);
        if (typeof session.collectedFields.firstName === "string" && session.collectedFields.firstName.trim()) {
          markNewPatientConfirmationPrompt(session, "firstName");
        }
        return {
          reply: session.newPatientDataConfirmation?.prompted?.field === "firstName"
            ? newPatientConfirmationQuestion(session, "firstName")
            : "Great. What is the patient's first name?",
          assistantMetadata: { intent: "BOOK_APPOINTMENT", source: "patient-status-choice" },
          shouldEndSession: false,
          shouldTransferToStaff: false
        };
      }
      if (choice !== "RETURNING_PATIENT") {
        session.awaitingBookingPatientChoice = true;
        return {
          reply: "Before we book, is the patient new to our office or have they visited before?",
          assistantMetadata: { intent: "BOOK_APPOINTMENT", source: "patient-status-question" },
          shouldEndSession: false,
          shouldTransferToStaff: false
        };
      }
      session.bookingPatientChoice = choice;
      if (choice === "RETURNING_PATIENT" && !session.collectedFields.firstName) {
        return {
          reply: "Please say and spell the patient's first name so I can find the right record.",
          assistantMetadata: { intent: "BOOK_APPOINTMENT", source: "returning-patient-name-prompt" },
          shouldEndSession: false,
          shouldTransferToStaff: false
        };
      }
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
    constrainNewPatientDataUpdates(session, firstResult);
    if (firstResult.collectedFields) {
      session.collectedFields = {
        ...session.collectedFields,
        ...firstResult.collectedFields
      };
    }
    synchronizeNewPatientDataConfirmation(session, firstResult, callerText);
    hydrateConfirmAppointmentSelections(session);
    promoteConfirmAppointmentPendingAction(session, firstResult);

    const finalResult = await this.resolvePolicyAwareModelResult(session, firstResult);
    if (firstResult.toolRequest
      && firstResult.intent
      && !this.isTerminalIntent(finalResult.intent)) {
      finalResult.intent = firstResult.intent;
    }
    const reply = this.correctBookingReply(finalResult.reply ?? "I am sorry, I could not complete that request.", session);
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
    constrainNewPatientDataUpdates(session, finalResult);
    if (finalResult.collectedFields) {
      session.collectedFields = {
        ...session.collectedFields,
        ...finalResult.collectedFields
      };
    }
    synchronizeNewPatientDataConfirmation(session, finalResult);

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
    constrainNewPatientDataUpdates(session, result);
    if (!result.toolRequest) {
      return result;
    }

    const autoFinalizeSelectedSlot = result.toolRequest.name === "BOOK_APPOINTMENT"
      && this.callerSelectedAvailableSlot(session, result);

    if (result.toolRequest.name === "TRANSFER_TO_STAFF") {
      return this.offerStaffTransfer(session, "model-or-workflow-request");
    }

    if (result.toolRequest.name === "BOOK_APPOINTMENT") {
      result = await this.ensureBookingAppointmentType(session, result);
      if (!result.toolRequest) {
        return result;
      }
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
    if (result.toolRequest.name === "VERIFY_PATIENT"
      && isSuccessfulToolResult(toolResult)
      && session.workflowState?.workflow === "PATIENT_VERIFICATION"
      && session.workflowState.state === "COMPLETED") {
      for (const field of ["firstName", "dob"] as const) {
        const value = result.toolRequest.arguments[field];
        if (typeof value === "string" && value.trim()) {
          session.collectedFields[field] = value.trim();
        }
      }
    }
    const confirmedAppointment = result.toolRequest.name === "CONFIRM_APPOINTMENT" && isSuccessfulToolResult(toolResult)
      ? selectedConfirmAppointmentOption(session, result.toolRequest.arguments, result)
      : undefined;
    syncConfirmAppointmentFromLookup(session, result.toolRequest.name, toolResult, session.currentIntent, result);
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

    if (result.toolRequest.name === "CONFIRM_APPOINTMENT" && isSuccessfulToolResult(toolResult)) {
      return {
        ...result,
        toolRequest: undefined,
        shouldEndCall: false,
        reply: confirmedAppointment?.appointmentDate
          ? `Your appointment at ${confirmedAppointment.appointmentDate} has been confirmed.`
          : "Your appointment has been confirmed successfully."
      };
    }

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
      if (autoFinalizeSelectedSlot
        && isSuccessfulToolResult(toolResult)
        && session.workflowState.context?.slotDate === result.toolRequest.arguments.slotDate
        && session.workflowState.context?.slotTime === result.toolRequest.arguments.slotTime) {
        return this.resolveModelResult(session, {
          intent: "BOOK_APPOINTMENT",
          toolRequest: {
            name: "BOOK_APPOINTMENT",
            arguments: {
              ...result.toolRequest.arguments,
              callerConfirmedBooking: true
            }
          }
        }, bookingFollowups, toolChainDepth + 1);
      }
      return this.modelClient.bookingResponse(session, "AWAITING_CONFIRMATION");
    }

    if (result.toolRequest.name === "BOOK_APPOINTMENT"
      && isSuccessfulToolResult(toolResult)
      && session.workflowState?.workflow === "BOOK_APPOINTMENT"
      && session.workflowState.state === "COMPLETED") {
      const slotDate = session.workflowState.context?.slotDate;
      const slotTime = session.workflowState.context?.slotTime;
      return {
        intent: "BOOK_APPOINTMENT",
        reply: typeof slotDate === "string" && typeof slotTime === "string"
          ? `Your appointment is booked for ${slotDate} at ${slotTime}.`
          : "Your appointment is booked.",
        shouldEndCall: false
      };
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
    if (session.workflowState?.workflow === "BOOK_APPOINTMENT"
      && session.workflowState.state === "NEEDS_SCHEDULING_PREFERENCE"
      && result.toolRequest?.name === "BOOK_APPOINTMENT") {
      logger.warn("Blocked booking follow-up during scheduling preference state", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        state: session.workflowState.state,
        followups
      });
      return this.modelClient.bookingResponse(session, "SCHEDULING_PREFERENCE");
    }

    if (session.workflowState?.workflow === "BOOK_APPOINTMENT"
      && session.workflowState.state === "NEEDS_INPUT"
      && session.workflowState.requiredField === "appointmentTypeId") {
      const bookingResult: ModelTurnResult = result.toolRequest?.name === "BOOK_APPOINTMENT"
        ? result
        : {
          ...result,
          intent: "BOOK_APPOINTMENT",
          toolRequest: {
            name: "BOOK_APPOINTMENT",
            arguments: {
              ...session.collectedFields,
              bookingReason: session.collectedFields.bookingReason
                ?? session.workflowState.context?.bookingReason
            }
          }
        };
      const correctedResult = await this.ensureBookingAppointmentType(session, bookingResult);
      if (correctedResult.toolRequest?.name === "BOOK_APPOINTMENT"
        && isEligibleAppointmentTypeId(session, correctedResult.toolRequest.arguments.appointmentTypeId)) {
        result = prepareBookingFollowup(session, correctedResult, followups);
        constrainNewPatientDataUpdates(session, result);
        if (result.collectedFields) {
          session.collectedFields = { ...session.collectedFields, ...result.collectedFields };
        }
        logger.info("Executing corrected booking after appointment type validation", {
          callSid: session.callSid,
          officeCode: session.officeCode,
          appointmentTypeId: correctedResult.toolRequest.arguments.appointmentTypeId,
          followups: followups + 1
        });
        return this.resolveModelResult(session, result, followups + 1);
      }

      if (!correctedResult.toolRequest) {
        return correctedResult;
      }

      logger.warn("Blocked booking follow-up without a valid appointment type", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        requestedToolName: result.toolRequest?.name,
        workflowStateSummary: this.workflowStateSummary(session)
      });
      return this.modelClient.bookingResponse(session, "APPOINTMENT_TYPE_CLARIFICATION");
    }

    result = prepareBookingFollowup(session, result, followups);
    constrainNewPatientDataUpdates(session, result);
    if (result.collectedFields) {
      session.collectedFields = { ...session.collectedFields, ...result.collectedFields };
    }
    if (!result.toolRequest || result.toolRequest.name === "TRANSFER_TO_STAFF") return result;
    logger.info("Executing booking follow-up tool", { callSid: session.callSid, state: session.workflowState?.state, followups: followups + 1 });
    return this.resolveModelResult(session, result, followups + 1);
  }

  private async ensureBookingAppointmentType(
    session: CallSession,
    result: ModelTurnResult
  ): Promise<ModelTurnResult> {
    if (result.toolRequest?.name !== "BOOK_APPOINTMENT") {
      return result;
    }

    const candidateId = result.toolRequest.arguments.appointmentTypeId
      ?? result.collectedFields?.appointmentTypeId
      ?? session.collectedFields.appointmentTypeId
      ?? session.workflowState?.context?.appointmentTypeId;
    if (isEligibleAppointmentTypeId(session, candidateId)) {
      return {
        ...result,
        collectedFields: {
          ...result.collectedFields,
          appointmentTypeId: candidateId
        },
        toolRequest: {
          ...result.toolRequest,
          arguments: {
            ...result.toolRequest.arguments,
            appointmentTypeId: candidateId
          }
        }
      };
    }

    if (!session.officeContext?.appointmentTypes) {
      if (session.officeContext) {
        logger.error("Booking blocked because office appointment catalog is unavailable", {
          callSid: session.callSid,
          officeCode: session.officeCode
        });
        return this.modelClient.bookingResponse(session, "APPOINTMENT_TYPE_CLARIFICATION");
      }
      return result;
    }

    const selectedId = await this.modelClient.selectBookingAppointmentType(
      session,
      bookingReason(session, result.toolRequest.arguments.bookingReason ?? result.collectedFields?.bookingReason)
    );
    if (selectedId === undefined) {
      logger.warn("Booking blocked because appointment type could not be resolved", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        workflowStateSummary: this.workflowStateSummary(session)
      });
      return this.modelClient.bookingResponse(session, "APPOINTMENT_TYPE_CLARIFICATION");
    }

    return {
      ...result,
      collectedFields: {
        ...result.collectedFields,
        appointmentTypeId: selectedId
      },
      toolRequest: {
        ...result.toolRequest,
        arguments: {
          ...result.toolRequest.arguments,
          appointmentTypeId: selectedId
        }
      }
    };
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
    if (policyDecision.repromptContext?.type === "BOOKING_SLOT_REPEAT") {
      return this.modelClient.bookingResponse(session, "REPEAT_SLOTS");
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
    constrainNewPatientDataUpdates(session, repromptResult);
    if (repromptResult.collectedFields) {
      session.collectedFields = {
        ...session.collectedFields,
        ...repromptResult.collectedFields
      };
    }
    synchronizeNewPatientDataConfirmation(session, repromptResult);

    hydrateConfirmAppointmentSelections(session);
    promoteConfirmAppointmentPendingAction(session, repromptResult);

    if (!repromptResult.toolRequest && session.pendingActions.CONFIRM_APPOINTMENT?.status !== "READY_TO_EXECUTE") {
      return repromptResult;
    }

    return this.resolvePolicyAwareModelResult(session, repromptResult);
  }

  private applyDeterministicCallerAuthorization(
    session: CallSession,
    callerText: string,
    result: ModelTurnResult
  ): ModelTurnResult {
    if (result.callerAction?.authorization?.stateChangingAction === "CONTINUE_AS_NEW_PATIENT") {
      return result;
    }

    const previousAssistantText = [...session.transcript]
      .reverse()
      .find((turn) => turn.speaker === "assistant")?.text;
    if (!callerTextExplicitlyContinuesAsNewPatient(callerText, previousAssistantText)) {
      return result;
    }

    logger.info("Applied deterministic new-patient authorization from caller speech", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      callerText
    });
    return {
      ...result,
      intent: "BOOK_APPOINTMENT",
      callerAction: {
        speechAct: "AUTHORIZATION",
        workflowIntent: "BOOK_APPOINTMENT",
        requestedAction: "BOOK_APPOINTMENT",
        authorization: {
          stateChangingAction: "CONTINUE_AS_NEW_PATIENT",
          isExplicit: true
        }
      }
    };
  }

  private correctBookingReply(reply: string, session: CallSession): string {
    if (session.workflowState?.workflow !== "BOOK_APPOINTMENT") {
      return reply;
    }

    const context = session.workflowState.context;
    const knownDates: unknown[] = [context?.slotDate];
    if (Array.isArray(context?.slots)) {
      knownDates.push(...context.slots.map((slot) => (
        slot && typeof slot === "object" && !Array.isArray(slot)
          ? (slot as { slotDate?: unknown }).slotDate
          : undefined
      )));
    }
    return correctBookingRelativeDateMentions(
      correctBookingWeekdayMentions(reply, knownDates),
      session.officeContext?.timezone,
      session.startedAt
    );
  }

  private isTerminalIntent(intent: string | undefined): boolean {
    return intent === "TRANSFER_TO_STAFF" || intent === "HANDOFF_TO_STAFF";
  }

  private callerSelectedAvailableSlot(session: CallSession, result: ModelTurnResult): boolean {
    if (session.workflowState?.workflow !== "BOOK_APPOINTMENT"
      || session.workflowState.state !== "SELECT_SLOT") {
      return false;
    }

    const requestedSlot = result.toolRequest?.arguments;
    const slots = session.workflowState.context?.slots;
    if (!requestedSlot || !Array.isArray(slots)
      || !slots.some((slot) => slot && typeof slot === "object"
        && (slot as { slotDate?: unknown; slotTime?: unknown }).slotDate === requestedSlot.slotDate
        && (slot as { slotDate?: unknown; slotTime?: unknown }).slotTime === requestedSlot.slotTime)) {
      return false;
    }

    const patientTurns = session.transcript.filter((turn) => turn.speaker === "patient");
    const callerText = patientTurns.at(-1)?.text.trim() ?? "";
    const bookingRequested = patientTurns.some((turn) =>
      /\b(?:book|schedule|make|set up)\b.{0,50}\bappointment\b/i.test(turn.text)
    );
    if (!bookingRequested || !callerText
      || /\?|\b(?:no|not|maybe|perhaps|might|unsure|not sure|what about|do you have)\b/i.test(callerText)) {
      return false;
    }

    const choiceIsAffirmative = /\b(?:good|fine|perfect|works?|take|choose|pick|book|reserve|go with|that one)\b/i.test(callerText)
      || /^\s*(?:the\s+)?\d{1,2}:\d{2}\s*(?:am|pm)?[.!]?\s*$/i.test(callerText);
    if (!choiceIsAffirmative || typeof requestedSlot.slotTime !== "string") {
      return false;
    }

    const selectedTime = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(requestedSlot.slotTime.trim());
    if (!selectedTime) {
      return false;
    }
    const spokenTimes = [...callerText.matchAll(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi)];
    const matchingSpokenTime = spokenTimes.find((time) =>
      Number(time[1]) === Number(selectedTime[1])
      && time[2] === selectedTime[2]
      && (!time[3] || time[3].toLowerCase() === selectedTime[3].toLowerCase())
    );
    if (!matchingSpokenTime) {
      return false;
    }

    const matchingOfferedSlots = slots.filter((slot) => {
      const time = slot && typeof slot === "object" && "slotTime" in slot
        ? (slot as { slotTime?: unknown }).slotTime
        : undefined;
      const parsed = typeof time === "string" ? /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(time.trim()) : null;
      return parsed && Number(parsed[1]) === Number(selectedTime[1])
        && parsed[2] === selectedTime[2]
        && (!matchingSpokenTime[3] || parsed[3].toLowerCase() === selectedTime[3].toLowerCase());
    });
    if (matchingOfferedSlots.length !== 1) {
      return false;
    }

    return true;
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
