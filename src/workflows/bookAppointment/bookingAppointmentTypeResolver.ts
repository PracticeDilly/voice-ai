import type { CallSession } from "../../calls/callSession.js";
import type { ModelTurnResult } from "../../conversation/modelClient.js";
import type { BookingResponsePurpose } from "./bookingResponseContext.js";
import { logger } from "../../utils/logger.js";
import { bookingReason, isEligibleAppointmentTypeId } from "./appointmentTypeSelection.js";

export interface BookingAppointmentTypeResolutionPort {
  selectAppointmentType(session: CallSession, reason?: string): Promise<number | undefined>;
  bookingResponse(session: CallSession, purpose: BookingResponsePurpose): Promise<ModelTurnResult>;
}

export async function ensureBookingAppointmentType(
  session: CallSession,
  result: ModelTurnResult,
  resolution: BookingAppointmentTypeResolutionPort
): Promise<ModelTurnResult> {
  if (result.toolRequest?.name !== "BOOK_APPOINTMENT") {
    return result;
  }

  const candidateId = result.toolRequest.arguments.appointmentTypeId
    ?? result.collectedFields?.appointmentTypeId
    ?? session.collectedFields.appointmentTypeId
    ?? session.workflowState?.context?.appointmentTypeId;
  if (isEligibleAppointmentTypeId(session, candidateId)) {
    return withAppointmentTypeId(result, candidateId);
  }

  if (!session.officeContext?.appointmentTypes) {
    if (session.officeContext) {
      logger.error("Booking blocked because office appointment catalog is unavailable", {
        callSid: session.callSid,
        officeCode: session.officeCode
      });
      return resolution.bookingResponse(session, "APPOINTMENT_TYPE_CLARIFICATION");
    }
    return result;
  }

  const selectedId = await resolution.selectAppointmentType(
    session,
    bookingReason(session, result.toolRequest.arguments.bookingReason ?? result.collectedFields?.bookingReason)
  );
  if (selectedId === undefined) {
    logger.warn("Booking blocked because appointment type could not be resolved", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      workflowState: session.workflowState?.state
    });
    return resolution.bookingResponse(session, "APPOINTMENT_TYPE_CLARIFICATION");
  }

  return withAppointmentTypeId(result, selectedId);
}

export function hasEligibleBookingAppointmentType(session: CallSession, result: ModelTurnResult): boolean {
  return result.toolRequest?.name === "BOOK_APPOINTMENT"
    && isEligibleAppointmentTypeId(session, result.toolRequest.arguments.appointmentTypeId);
}

function withAppointmentTypeId(result: ModelTurnResult, appointmentTypeId: number): ModelTurnResult {
  return {
    ...result,
    collectedFields: {
      ...result.collectedFields,
      appointmentTypeId
    },
    toolRequest: {
      ...result.toolRequest!,
      arguments: {
        ...result.toolRequest!.arguments,
        appointmentTypeId
      }
    }
  };
}
