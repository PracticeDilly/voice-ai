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

    if (isPrematureBookingHandoff(result)) {
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

function isPrematureBookingHandoff(result: ModelTurnResult): boolean {
  if (result.toolRequest?.name !== "TRANSFER_TO_STAFF" && result.intent !== "TRANSFER_TO_STAFF") {
    return false;
  }

  if (result.callerAction?.requestedAction === "TRANSFER_TO_STAFF"
    || result.callerAction?.workflowIntent === "TRANSFER_TO_STAFF") {
    return false;
  }

  return hasBookingField(result.collectedFields);
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
