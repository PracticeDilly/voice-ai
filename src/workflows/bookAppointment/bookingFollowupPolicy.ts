import type { CallSession } from "../../calls/callSession.js";
import type { ModelTurnResult } from "../../conversation/modelClient.js";
import { logger } from "../../utils/logger.js";
import { constrainNewPatientDataUpdates } from "../shared/newPatientDataConfirmation.js";
import type { WorkflowFollowupDecision } from "../shared/workflowTypes.js";
import { prepareBookingFollowup } from "./bookingFollowup.js";
import { ensureBookingAppointmentType, hasEligibleBookingAppointmentType, BookingAppointmentTypeResolutionPort } from "./bookingAppointmentTypeResolver.js";

export async function prepareBookingWorkflowFollowup(
  session: CallSession,
  result: ModelTurnResult,
  followups: number,
  resolution: BookingAppointmentTypeResolutionPort
): Promise<WorkflowFollowupDecision> {
  if (session.workflowState?.workflow === "BOOK_APPOINTMENT"
    && session.workflowState.state === "NEEDS_SCHEDULING_PREFERENCE"
    && result.toolRequest?.name === "BOOK_APPOINTMENT") {
    logger.warn("Blocked booking follow-up during scheduling preference state", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      state: session.workflowState.state,
      followups
    });
    return {
      disposition: "RETURN",
      result: await resolution.bookingResponse(session, "SCHEDULING_PREFERENCE")
    };
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
    const correctedResult = await ensureBookingAppointmentType(session, bookingResult, resolution);
    if (hasEligibleBookingAppointmentType(session, correctedResult)) {
      const preparedResult = prepareBookingFollowup(session, correctedResult, followups);
      persistCollectedFields(session, preparedResult);
      logger.info("Executing corrected booking after appointment type validation", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        appointmentTypeId: correctedResult.toolRequest?.arguments.appointmentTypeId,
        followups: followups + 1
      });
      return { disposition: "CONTINUE_TOOL_CHAIN", result: preparedResult };
    }

    if (!correctedResult.toolRequest) {
      return { disposition: "RETURN", result: correctedResult };
    }

    logger.warn("Blocked booking follow-up without a valid appointment type", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      requestedToolName: result.toolRequest?.name,
      workflowState: session.workflowState?.state
    });
    return {
      disposition: "RETURN",
      result: await resolution.bookingResponse(session, "APPOINTMENT_TYPE_CLARIFICATION")
    };
  }

  const preparedResult = prepareBookingFollowup(session, result, followups);
  persistCollectedFields(session, preparedResult);
  if (!preparedResult.toolRequest || preparedResult.toolRequest.name === "TRANSFER_TO_STAFF") {
    return { disposition: "RETURN", result: preparedResult };
  }
  logger.info("Executing booking follow-up tool", {
    callSid: session.callSid,
    state: session.workflowState?.state,
    followups: followups + 1
  });
  return { disposition: "CONTINUE_TOOL_CHAIN", result: preparedResult };
}

function persistCollectedFields(session: CallSession, result: ModelTurnResult): void {
  constrainNewPatientDataUpdates(session, result);
  if (result.collectedFields) {
    session.collectedFields = { ...session.collectedFields, ...result.collectedFields };
  }
}
