import { ToolRequest } from "../../backend/springBootClient.js";
import { CallSession } from "../../calls/callSession.js";
import { logger } from "../../utils/logger.js";
import { WorkflowToolAdapter } from "../shared/workflowTypes.js";
import { isBookingDatePreferenceValid, isBookingDateRangeValid } from "./bookingDatePreference.js";
import { normalizeBookingArguments } from "./bookingArgumentNormalizer.js";
import { providerNameMatchesOfficeContext } from "./officeContextProviders.js";

const SLOT_NOT_AVAILABLE_MESSAGE = "Select a slot returned by the availability search.";

export class BookAppointmentToolAdapter implements WorkflowToolAdapter {
  supports(tool: ToolRequest): boolean {
    return tool.name === "BOOK_APPOINTMENT";
  }

  prepareTool(session: CallSession, tool: ToolRequest): ToolRequest {
    const preparedArguments = normalizeBookingArguments(session, tool.arguments);
    logger.debug("Prepared booking tool arguments", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      hasBookingReason: preparedArguments.bookingReason !== undefined,
      appointmentTypeId: preparedArguments.appointmentTypeId,
      hasProviderName: preparedArguments.providerName !== undefined,
      hasDatePreference: preparedArguments.datePreference !== undefined,
      hasTimePreference: preparedArguments.timePreference !== undefined,
      hasSlotDate: preparedArguments.slotDate !== undefined,
      hasSlotTime: preparedArguments.slotTime !== undefined,
      callerConfirmedBooking: preparedArguments.callerConfirmedBooking === true
    });

    return {
      ...tool,
      arguments: preparedArguments
    };
  }

  validateTool(session: CallSession, tool: ToolRequest): string | undefined {
    if (tool.name !== "BOOK_APPOINTMENT") {
      return undefined;
    }

    const providerName = tool.arguments?.providerName;
    if (providerName && !providerNameMatchesOfficeContext(providerName, session.officeContext?.providers)) {
      return "Select a provider from office context only; clarify the caller's preference without offering widget providers.";
    }
    const appointmentTypeId = tool.arguments?.appointmentTypeId;
    const patientType = session.workflowState?.context?.patientType === "NEW_PATIENT"
      ? "NEW_PATIENT"
      : "RETURNING_PATIENT";
    if (appointmentTypeId !== undefined && !session.officeContext?.appointmentTypes?.[patientType]
      ?.some((type) => type.appointmentTypeId === appointmentTypeId && type.duration > 0)) {
      return `Select an eligible ${patientType} appointmentTypeId from office context based on bookingReason; clarify when ambiguous.`;
    }

    for (const fieldName of ["datePreference", "fromDate", "toDate"] as const) {
      const value = tool.arguments?.[fieldName];
      if (hasDateValue(value) && !isBookingDatePreferenceValid(value, session.officeContext?.timezone, session.startedAt)) {
        return "Please provide a specific valid appointment date, such as Monday or 09/14/2026.";
      }
    }

    if (tool.arguments?.fromDate !== undefined || tool.arguments?.toDate !== undefined) {
      if (!isBookingDateRangeValid(tool.arguments?.fromDate, tool.arguments?.toDate)) {
        return "Booking availability requires valid fromDate and toDate values; the maximum allowed difference is 7 days.";
      }
    }

    const requestedSlotDate = tool.arguments?.slotDate;
    const requestedSlotTime = tool.arguments?.slotTime;
    const requestedSlotError = validateAvailableSlot(
      session.workflowState?.context?.slots,
      requestedSlotDate,
      requestedSlotTime
    );
    if (requestedSlotError) {
      return requestedSlotError;
    }

    if (tool.arguments?.callerConfirmedBooking !== true) {
      return undefined;
    }

    if (session.workflowState?.workflow !== "BOOK_APPOINTMENT" || session.workflowState.state !== "REQUIRES_CONFIRMATION") {
      logger.warn("Blocked booking finalization before backend confirmation state", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        workflow: session.workflowState?.workflow,
        state: session.workflowState?.state
      });
      return "Booking can only be finalized after the backend has returned a booking confirmation step.";
    }

    const slotDate = tool.arguments?.slotDate ?? session.workflowState.context?.slotDate;
    const slotTime = tool.arguments?.slotTime ?? session.workflowState.context?.slotTime;
    if (slotDate === undefined || slotDate === null || slotDate === "" || slotTime === undefined || slotTime === null || slotTime === "") {
      logger.warn("Blocked booking finalization without selected slot date/time", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        hasSlotDate: slotDate !== undefined && slotDate !== null && slotDate !== "",
        hasSlotTime: slotTime !== undefined && slotTime !== null && slotTime !== ""
      });
      return "Booking confirmation requires the backend-selected slot date and time.";
    }

    const selectedSlotError = validateAvailableSlot(
      session.workflowState.context?.slots,
      slotDate,
      slotTime
    );
    if (selectedSlotError) {
      return selectedSlotError;
    }

    return undefined;
  }
}

function hasDateValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function validateAvailableSlot(
  slots: unknown[] | undefined,
  slotDate: unknown,
  slotTime: unknown
): string | undefined {
  if (!slots || slotDate === undefined || slotTime === undefined) {
    return undefined;
  }

  return slotExists(slots, slotDate, slotTime) ? undefined : SLOT_NOT_AVAILABLE_MESSAGE;
}

function slotExists(slots: unknown[], slotDate: unknown, slotTime: unknown): boolean {
  return slots.some((slot) => {
    if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
      return false;
    }
    const candidate = slot as { slotDate?: unknown; slotTime?: unknown };
    return candidate.slotDate === slotDate && candidate.slotTime === slotTime;
  });
}
