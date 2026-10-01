import { CallSession } from "../../calls/callSession.js";
import { BookingWorkflowError } from "./bookingModelContract.js";
import { logger } from "../../utils/logger.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import {
  callerActionAuthorizesNextAvailabilityLookup,
  callerActionExplicitlyAuthorizesBooking
} from "../shared/callerActionDecision.js";
import { bookingPatientChoiceFromModel } from "./bookingPatientChoice.js";
import { ConversationWorkflow, ToolPolicyDecision } from "../shared/workflowTypes.js";
import { BookAppointmentToolAdapter } from "./bookAppointmentToolAdapter.js";
import { BookingAppointmentTypeResolutionPort, ensureBookingAppointmentType } from "./bookingAppointmentTypeResolver.js";
import { prepareBookingWorkflowFollowup } from "./bookingFollowupPolicy.js";
import {
  callerSelectedAvailableBookingSlot,
  explicitlyAuthorizedAvailableBookingSlot
} from "./bookingSlotSelection.js";
import {
  addDaysToBookingDate,
  correctBookingRelativeDateMentions,
  correctBookingWeekdayMentions
} from "./bookingDatePreference.js";
import {
  allNewPatientDataConfirmed,
  hasAllNewPatientData,
  isNewPatientBooking,
  newPatientDataFields,
  readBackNewPatientName,
  markNewPatientConfirmationPrompt,
  newPatientConfirmationQuestion,
  pendingNewPatientConfirmation
} from "../shared/newPatientDataConfirmation.js";

const toolAdapter = new BookAppointmentToolAdapter();

function initializeNewPatientBooking(session: CallSession): void {
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

export function createBookAppointmentWorkflow(
  appointmentTypeResolution?: BookingAppointmentTypeResolutionPort
): ConversationWorkflow {
  return {
  name: "BOOK_APPOINTMENT",
  toolAdapter,
  handleError(session, error) {
    if (!(error instanceof BookingWorkflowError)) {
      return undefined;
    }
    logger.warn("Booking execution requires staff handoff confirmation", {
      callSid: session.callSid,
      reason: error.message
    });
    return { staffTransferReason: "booking-workflow-failure" };
  },
  startNewPatientBooking(session) {
    initializeNewPatientBooking(session);
  },
  handleBookingEntry(session, _callerText, result) {
    if (result.intent?.trim().toUpperCase() !== "BOOK_APPOINTMENT"
      || !session.fromNumber
      || session.workflowState
      || session.bookingPatientChoice) {
      return undefined;
    }

    session.currentIntent = "BOOK_APPOINTMENT";
    session.collectedFields = { ...session.collectedFields, ...(result.collectedFields ?? {}) };
    const choice = bookingPatientChoiceFromModel(result);
    if (choice === "NEW_PATIENT") {
      session.awaitingBookingPatientChoice = false;
      initializeNewPatientBooking(session);
      const collection = newPatientDataConfirmationDecision(session, result);
      return {
        reply: readBackNewPatientName(session, collection?.overrideResult?.reply
          ?? "Great. What is the patient's full name?"),
        source: "patient-status-choice"
      };
    }
    if (choice !== "RETURNING_PATIENT") {
      session.awaitingBookingPatientChoice = true;
      return {
        reply: "Before we book, is the patient new to our office or have they visited before?",
        source: "patient-status-question"
      };
    }

    session.awaitingBookingPatientChoice = false;
    session.bookingPatientChoice = choice;
    return !session.collectedFields.firstName
      ? {
        reply: "What is the patient's first name so I can find the right record?",
        source: "returning-patient-name-prompt"
      }
      : undefined;
  },
  prepareReply(session, reply) {
    reply = readBackNewPatientName(session, reply);
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
  },
  prepareModelResult(session, _callerText, result) {
    const previousAssistantText = [...session.transcript].reverse()
      .find((turn) => turn.speaker === "assistant")?.text ?? "";
    if (session.workflowState?.workflow !== "BOOK_APPOINTMENT"
      || session.workflowState.state !== "NEEDS_SCHEDULING_PREFERENCE"
      || !session.lastBookingSearchRange
      || !/\b(?:next|earliest|first) available\b/i.test(previousAssistantText)
      || !callerActionAuthorizesNextAvailabilityLookup(result)) {
      return result;
    }

    const fromDate = addDaysToBookingDate(session.lastBookingSearchRange.toDate, 1);
    const toDate = addDaysToBookingDate(fromDate, 7);
    if (!fromDate || !toDate) {
      return result;
    }

    return {
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
  },
  async prepareToolRequest(session, result) {
    return appointmentTypeResolution
      ? ensureBookingAppointmentType(session, result, appointmentTypeResolution)
      : result;
  },
  async prepareFollowup(session, result, followups) {
    if (!appointmentTypeResolution) {
      return { disposition: "RETURN", result };
    }
    return prepareBookingWorkflowFollowup(session, result, followups, appointmentTypeResolution);
  },
  callerSelectedAvailableSlot(session, result) {
    return callerSelectedAvailableBookingSlot(session, result);
  },
  async resolveToolResult(session, request, toolResult, context) {
    if (!appointmentTypeResolution
      || request.toolRequest?.name !== "BOOK_APPOINTMENT"
      || session.workflowState?.workflow !== "BOOK_APPOINTMENT"
      || session.workflowState.state !== "REQUIRES_CONFIRMATION") {
      return undefined;
    }

    const requestedSlot = request.toolRequest.arguments;
    if (context.callerSelectedAvailableSlot
      && isSuccessfulToolResult(toolResult)
      && session.workflowState.context?.slotDate === requestedSlot.slotDate
      && session.workflowState.context?.slotTime === requestedSlot.slotTime) {
      return {
        ...request,
        intent: "BOOK_APPOINTMENT",
        toolRequest: {
          ...request.toolRequest,
          arguments: { ...requestedSlot, callerConfirmedBooking: true }
        }
      };
    }

    return appointmentTypeResolution.bookingResponse(session, "AWAITING_CONFIRMATION");
  },
  async resolvePolicyReprompt(session, context) {
    if (!appointmentTypeResolution) {
      return undefined;
    }
    if (context.type === "BOOKING_CONFIRMATION") {
      return appointmentTypeResolution.bookingResponse(session, "AWAITING_CONFIRMATION");
    }
    if (context.type === "BOOKING_SLOT_REPEAT") {
      return appointmentTypeResolution.bookingResponse(session, "REPEAT_SLOTS");
    }
    return undefined;
  },
  applyTurnPolicy(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
    if (!isBookingIntent(session.currentIntent) && session.workflowState?.workflow !== "BOOK_APPOINTMENT") {
      return undefined;
    }

    const patientDataConfirmation = newPatientDataConfirmationDecision(session, result);
    if (patientDataConfirmation) {
      return patientDataConfirmation;
    }

    const selectedSlot = explicitlyAuthorizedAvailableBookingSlot(session, result);
    if (selectedSlot) {
      return {
        overrideResult: {
          ...result,
          intent: "BOOK_APPOINTMENT",
          shouldEndCall: false,
          toolRequest: {
            name: "BOOK_APPOINTMENT",
            arguments: {
              ...session.collectedFields,
              ...result.collectedFields,
              ...result.toolRequest?.arguments,
              ...selectedSlot,
              callerConfirmedBooking: false
            }
          }
        }
      };
    }

    if (isBookingSlotRepeatRequest(session, result)) {
      return { repromptContext: { type: "BOOKING_SLOT_REPEAT" } };
    }

    if (isBookingAwaitingConfirmation(session)) {
      return bookingConfirmationDecision(result);
    }

    if (isPrematureBookingHandoff(session, result)) {
      if (isRecoverableAvailabilityState(session)) {
        return {
          instruction: "The booking workflow has recoverable availability information. Do not transfer to staff yet. Explain that the requested date or provider is unavailable and ask whether another date or available provider would work. Do not request another booking tool until the caller answers.",
          repromptContext: { type: "BOOKING_AVAILABILITY_ALTERNATIVE" }
        };
      }
      return {
        overrideResult: {
          ...result,
          intent: "BOOK_APPOINTMENT",
          shouldEndCall: false,
          toolRequest: {
            name: "BOOK_APPOINTMENT",
            arguments: {
              ...session.collectedFields,
              ...result.collectedFields
            }
          }
        }
      };
    }

    if (result.toolRequest || result.intent === "TRANSFER_TO_STAFF") {
      return undefined;
    }

    if (session.workflowState?.workflow !== "BOOK_APPOINTMENT") {
      return undefined;
    }

    if (["COMPLETED", "FAILED", "HANDOFF_REQUIRED"].includes(session.workflowState.state)) {
      return undefined;
    }

    if (!hasBookingField(result.collectedFields)) {
      return undefined;
    }

    return {
      overrideResult: {
        ...result,
        intent: "BOOK_APPOINTMENT",
        toolRequest: {
          name: "BOOK_APPOINTMENT",
          arguments: {
            ...result.collectedFields
          }
        }
      }
    };
  },
  applyToolResultPolicy(session: CallSession, toolName: string, toolResult: unknown): ToolPolicyDecision | undefined {
    if (toolName === "BOOK_APPOINTMENT"
      && isSuccessfulToolResult(toolResult)
      && session.workflowState?.workflow === "BOOK_APPOINTMENT"
      && session.workflowState.state === "COMPLETED") {
      const slotDate = session.workflowState.context?.slotDate;
      const slotTime = session.workflowState.context?.slotTime;
      return {
        overrideResult: {
          intent: "BOOK_APPOINTMENT",
          reply: typeof slotDate === "string" && typeof slotTime === "string"
            ? `Your appointment is booked for ${slotDate} at ${slotTime}.`
            : "Your appointment is booked.",
          shouldEndCall: false
        }
      };
    }

    if (toolName !== "BOOK_APPOINTMENT"
      || !isSuccessfulToolResult(toolResult)
      || session.workflowState?.workflow !== "BOOK_APPOINTMENT"
      || session.workflowState.state !== "NEEDS_INPUT"
      || session.workflowState.requiredField === "dob"
      || !hasMeaningfulValue(session.collectedFields.dob)) {
      return undefined;
    }

    const requiredField = session.workflowState.requiredField;
    return requiredField
      ? {
        instruction: `The caller's date of birth is already known and must not be requested again. The backend requires ${requiredField} next. Ask only for that required field; for appointmentTypeId, derive the eligible ID from bookingReason and office context and submit BOOK_APPOINTMENT.`,
        repromptContext: undefined
      }
      : undefined;
  }
  };
}

function isBookingIntent(intent: string | undefined): boolean {
  return typeof intent === "string" && intent.trim().toUpperCase() === "BOOK_APPOINTMENT";
}

function newPatientDataConfirmationDecision(
  session: CallSession,
  result: ModelTurnResult
): ToolPolicyDecision | undefined {
  if (!isNewPatientBooking(session)) {
    return undefined;
  }

  if (result.callerAction?.requestedAction === "TRANSFER_TO_STAFF"
    || result.callerAction?.workflowIntent === "TRANSFER_TO_STAFF") {
    return undefined;
  }

  const pendingField = pendingNewPatientConfirmation(session);
  const unclearField = (result.unclearFields ?? session.newPatientDataConfirmation?.unclearFields)?.find((field) =>
    (newPatientDataFields as readonly string[]).includes(field)
  );
  if (unclearField) {
    return { overrideResult: {
      ...result,
      reply: result.unclearFields?.includes(unclearField) && result.reply
        ? result.reply : "Could you please clarify the patient's "
          + ({ firstName: "first name", lastName: "last name", dob: "date of birth",
            gender: "gender", patientEmail: "email address", patientPhone: "phone number" }[unclearField] ?? "details") + "?",
      toolRequest: undefined,
      shouldEndCall: false
    } };
  }
  if (pendingField) {
    markNewPatientConfirmationPrompt(session, pendingField);
    return {
      overrideResult: {
        ...result,
        intent: "BOOK_APPOINTMENT",
        reply: newPatientConfirmationQuestion(session, pendingField),
        toolRequest: undefined,
        shouldEndCall: false
      }
    };
  }

  if (!hasAllNewPatientData(session)) {
    const missingField = newPatientDataFields.find((field) => (
      !session.collectedFields[field]
      && !(field === "patientPhone" && session.fromNumber)
    ));
    const questions: Record<string, string> = {
      firstName: "What is the patient's full name?",
      lastName: "What is the patient's last name?",
      dob: "What is the patient's date of birth?",
      gender: "What gender should I record for the patient?",
      patientEmail: "What is the patient's email address?",
      patientPhone: "What is the best phone number for the patient?"
    };
    if (missingField) {
      return {
        overrideResult: {
          ...result,
          intent: "BOOK_APPOINTMENT",
          reply: questions[missingField],
          toolRequest: undefined,
          shouldEndCall: false
        }
      };
    }
  }

  if (allNewPatientDataConfirmed(session)
    && !result.toolRequest
    && isBookingIntent(session.currentIntent)
    && ["NEEDS_NEW_PATIENT_DATA", "NEEDS_INPUT", "NEEDS_PROVIDER_SELECTION", "NEEDS_PATIENT_IDENTITY"]
      .includes(session.workflowState?.state ?? "")
    && hasBookingField(session.collectedFields)) {
    return {
      overrideResult: {
        ...result,
        intent: "BOOK_APPOINTMENT",
        toolRequest: {
          name: "BOOK_APPOINTMENT",
          arguments: {
            ...session.collectedFields,
            continueAsNewPatient: true
          }
        }
      }
    };
  }

  return undefined;
}

function isBookingAwaitingConfirmation(session: CallSession): boolean {
  return session.workflowState?.workflow === "BOOK_APPOINTMENT"
    && session.workflowState.state === "REQUIRES_CONFIRMATION";
}

function isBookingSlotRepeatRequest(session: CallSession, result: ModelTurnResult): boolean {
  if (result.toolRequest?.name !== "BOOK_APPOINTMENT"
    || session.workflowState?.workflow !== "BOOK_APPOINTMENT"
    || session.workflowState.state !== "SELECT_SLOT") {
    return false;
  }

  const lastCallerTurn = [...session.transcript].reverse().find((turn) => turn.speaker === "patient");
  const callerText = lastCallerTurn?.text.trim().toLowerCase() ?? "";
  // "the time slot at 12:30 works" is a slot selection, not a request to
  // repeat the available times. Only match explicit repetition language.
  return /\b(?:repeat|again|(?:available\s+)?(?:timings|times))\b/.test(callerText);
}

function bookingConfirmationDecision(result: ModelTurnResult): ToolPolicyDecision | undefined {
  if (result.callerAction?.requestedAction === "TRANSFER_TO_STAFF"
    || result.callerAction?.workflowIntent === "TRANSFER_TO_STAFF") {
    return undefined;
  }
  if (isConfirmedBookingTool(result)) {
    return undefined;
  }

  if (callerActionExplicitlyAuthorizesBooking(result)) {
    return {
      overrideResult: {
        ...result,
        intent: "BOOK_APPOINTMENT",
        shouldEndCall: false,
        toolRequest: {
          name: "BOOK_APPOINTMENT",
          arguments: {
            ...result.toolRequest?.arguments,
            callerConfirmedBooking: true
          }
        }
      }
    };
  }

  return { repromptContext: { type: "BOOKING_CONFIRMATION" } };
}

function isConfirmedBookingTool(result: ModelTurnResult): boolean {
  return result.toolRequest?.name === "BOOK_APPOINTMENT"
    && result.toolRequest.arguments?.callerConfirmedBooking === true;
}

function isPrematureBookingHandoff(session: CallSession, result: ModelTurnResult): boolean {
  if (result.toolRequest?.name !== "TRANSFER_TO_STAFF" && result.intent !== "TRANSFER_TO_STAFF") {
    return false;
  }

  if (session.workflowState?.workflow === "BOOK_APPOINTMENT"
    && ["FAILED", "HANDOFF_REQUIRED"].includes(session.workflowState.state)) {
    return false;
  }

  if (result.callerAction?.requestedAction === "TRANSFER_TO_STAFF"
    || result.callerAction?.workflowIntent === "TRANSFER_TO_STAFF") {
    return false;
  }

  return isBookingIntent(session.currentIntent) || hasBookingField(result.collectedFields);
}

function isRecoverableAvailabilityState(session: CallSession): boolean {
  return session.workflowState?.workflow === "BOOK_APPOINTMENT"
    && ["NEEDS_NEW_PATIENT_DATA", "NEEDS_SCHEDULING_PREFERENCE", "NEEDS_PROVIDER_SELECTION", "SELECT_SLOT"].includes(session.workflowState.state);
}

function hasBookingField(fields: Record<string, unknown> | undefined): boolean {
  if (!fields) return false;

  const bookingFields = [
    "firstName", "lastName", "dob", "gender", "bookingReason", "appointmentTypeId",
    "providerName", "patientPhone", "patientEmail", "datePreference", "timePreference", "slotDate", "slotTime", "fromDate", "toDate",
    "callerConfirmedBooking"
  ];
  return bookingFields.some((field) => fields[field] !== undefined && fields[field] !== null && fields[field] !== "");
}

function isSuccessfulToolResult(toolResult: unknown): boolean {
  return typeof toolResult === "object"
    && toolResult !== null
    && "ok" in toolResult
    && (toolResult as { ok?: unknown }).ok === true;
}

function hasMeaningfulValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}
