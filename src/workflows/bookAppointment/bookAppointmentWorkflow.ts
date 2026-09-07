import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";
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

    if (isBookingAwaitingConfirmation(session) && !isConfirmedBookingTool(result)) {
      return {
        overrideResult: {
          ...result,
          intent: "BOOK_APPOINTMENT",
          reply: confirmationPrompt(session),
          shouldEndCall: false,
          toolRequest: undefined
        }
      };
    }

    if (isPrematureBookingHandoff(session, result)) {
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

function isConfirmedBookingTool(result: ModelTurnResult): boolean {
  return result.toolRequest?.name === "BOOK_APPOINTMENT"
    && result.toolRequest.arguments?.callerConfirmedBooking === true;
}

function confirmationPrompt(session: CallSession): string {
  const context = session.workflowState?.context;
  const details = [
    context?.bookingReason,
    context?.providerName ? `with ${context.providerName}` : undefined,
    context?.slotDate ? `on ${context.slotDate}` : undefined,
    context?.slotTime ? `at ${context.slotTime}` : undefined
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);

  const appointmentDetails = details.length ? ` for ${details.join(" ")}` : "";
  return `This appointment is not booked yet. Please confirm if you would like me to book it${appointmentDetails}.`;
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

function hasBookingField(fields: Record<string, unknown> | undefined): boolean {
  if (!fields) {
    return false;
  }

  return [
    "firstName",
    "lastName",
    "dob",
    "bookingReason",
    "providerName",
    "datePreference",
    "timePreference",
    "slotDate",
    "slotTime",
    "callerConfirmedBooking"
  ].some((fieldName) => fields[fieldName] !== undefined && fields[fieldName] !== null && fields[fieldName] !== "");
}
