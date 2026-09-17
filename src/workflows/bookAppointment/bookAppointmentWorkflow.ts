import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { callerActionExplicitlyAuthorizesBooking } from "../shared/callerActionDecision.js";
import { ConversationWorkflow, ToolPolicyDecision } from "../shared/workflowTypes.js";
import { BookAppointmentToolAdapter } from "./bookAppointmentToolAdapter.js";
import {
  allNewPatientDataConfirmed,
  hasAllNewPatientData,
  isNewPatientBooking,
  markNewPatientConfirmationPrompt,
  markNewPatientSummaryPrompt,
  newPatientConfirmationQuestion,
  newPatientSummaryQuestion,
  pendingNewPatientConfirmation
} from "./newPatientDataConfirmation.js";

const toolAdapter = new BookAppointmentToolAdapter();

export const bookAppointmentWorkflow: ConversationWorkflow = {
  name: "BOOK_APPOINTMENT",
  toolAdapter,
  applyTurnPolicy(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
    if (!isBookingIntent(session.currentIntent) && session.workflowState?.workflow !== "BOOK_APPOINTMENT") {
      return undefined;
    }

    const patientDataConfirmation = newPatientDataConfirmationDecision(session, result);
    if (patientDataConfirmation) {
      return patientDataConfirmation;
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

  if (hasAllNewPatientData(session) && !allNewPatientDataConfirmed(session)) {
    if (session.newPatientDataConfirmation?.summaryAwaitingCorrection) {
      return {
        overrideResult: {
          ...result,
          intent: "BOOK_APPOINTMENT",
          reply: "Which patient detail would you like to correct?",
          toolRequest: undefined,
          shouldEndCall: false
        }
      };
    }

    markNewPatientSummaryPrompt(session);
    return {
      overrideResult: {
        ...result,
        intent: "BOOK_APPOINTMENT",
        reply: newPatientSummaryQuestion(session),
        toolRequest: undefined,
        shouldEndCall: false
      }
    };
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
  return /\b(repeat|again|timings?|times?)\b/.test(callerText);
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
