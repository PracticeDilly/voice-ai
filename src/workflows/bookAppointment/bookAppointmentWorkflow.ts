import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
import { callerActionExplicitlyAuthorizesBooking } from "../shared/callerActionDecision.js";
import { ConversationWorkflow, ToolPolicyDecision } from "../shared/workflowTypes.js";
import { BookAppointmentToolAdapter } from "./bookAppointmentToolAdapter.js";

const toolAdapter = new BookAppointmentToolAdapter();

export const bookAppointmentWorkflow: ConversationWorkflow = {
  name: "BOOK_APPOINTMENT",
  toolAdapter,
  applyTurnPolicy(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined {
    if (!isBookingIntent(session.currentIntent) && session.workflowState?.workflow !== "BOOK_APPOINTMENT") {
      return undefined;
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
  }
};

function isBookingIntent(intent: string | undefined): boolean {
  return typeof intent === "string" && intent.trim().toUpperCase() === "BOOK_APPOINTMENT";
}

function isBookingAwaitingConfirmation(session: CallSession): boolean {
  return session.workflowState?.workflow === "BOOK_APPOINTMENT"
    && session.workflowState.state === "REQUIRES_CONFIRMATION";
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
    && ["NEEDS_SCHEDULING_PREFERENCE", "NEEDS_PROVIDER_SELECTION", "SELECT_SLOT"].includes(session.workflowState.state);
}

function hasBookingField(fields: Record<string, unknown> | undefined): boolean {
  if (!fields) return false;

  const bookingFields = [
    "firstName", "lastName", "dob", "bookingReason", "appointmentTypeId",
    "providerName", "datePreference", "timePreference", "slotDate", "slotTime", "fromDate", "toDate",
    "callerConfirmedBooking"
  ];
  return bookingFields.some((field) => fields[field] !== undefined && fields[field] !== null && fields[field] !== "");
}
