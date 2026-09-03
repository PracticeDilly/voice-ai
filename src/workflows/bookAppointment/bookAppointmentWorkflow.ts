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

function hasBookingField(fields: Record<string, unknown> | undefined): boolean {
  if (!fields) {
    return false;
  }

  return [
    "firstName",
    "lastName",
    "dob",
    "reason",
    "providerName",
    "datePreference",
    "timePreference",
    "slotDate",
    "slotTime",
    "callerConfirmedBooking"
  ].some((fieldName) => fields[fieldName] !== undefined && fields[fieldName] !== null && fields[fieldName] !== "");
}
