import type { CallSession } from "../../calls/callSession.js";
import type { ModelTurnResult } from "../../conversation/modelClient.js";
import { BookingWorkflowError } from "./bookingModelContract.js";

const maxBookingFollowups = 2;
const terminalStates = new Set(["COMPLETED", "FAILED", "HANDOFF_REQUIRED"]);

export function prepareBookingFollowup(
  session: CallSession, result: ModelTurnResult, followups: number
): ModelTurnResult {
  const isTransfer = result.toolRequest?.name === "TRANSFER_TO_STAFF";
  if (terminalStates.has(session.workflowState?.state ?? "")) {
    return { ...result, collectedFields: undefined, callerAction: undefined, toolRequest: isTransfer ? result.toolRequest : undefined };
  }
  if (result.toolRequest && !isTransfer) {
    if (result.toolRequest.name !== "BOOK_APPOINTMENT" || followups >= maxBookingFollowups) {
      throw new BookingWorkflowError("Booking follow-up cannot safely continue");
    }
  }
  // Tool continuations contain no new caller turn and cannot grant booking approval.
  return {
    ...result,
    callerAction: undefined,
    collectedFields: result.collectedFields ? { ...result.collectedFields, callerConfirmedBooking: false } : undefined,
    toolRequest: result.toolRequest && !isTransfer
      ? { ...result.toolRequest, arguments: { ...result.toolRequest.arguments, callerConfirmedBooking: false } }
      : result.toolRequest
  };
}
