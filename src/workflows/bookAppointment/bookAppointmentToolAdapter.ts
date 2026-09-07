import { ToolRequest } from "../../backend/springBootClient.js";
import { CallSession } from "../../calls/callSession.js";
import { logger } from "../../utils/logger.js";
import { WorkflowToolAdapter } from "../shared/workflowTypes.js";
import { normalizeBookingArguments } from "./bookingArgumentNormalizer.js";

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
      hasProviderName: preparedArguments.providerName !== undefined,
      hasDatePreference: preparedArguments.datePreference !== undefined,
      hasTimePreference: preparedArguments.timePreference !== undefined,
      hasSlotDate: preparedArguments.slotDate !== undefined,
      hasSlotTime: preparedArguments.slotTime !== undefined,
      callerConfirmedBooking: preparedArguments.callerConfirmedBooking === true
    });

    return {
      ...tool,
      arguments: {
        ...tool.arguments,
        ...preparedArguments
      }
    };
  }

  validateTool(session: CallSession, tool: ToolRequest): string | undefined {
    if (tool.name !== "BOOK_APPOINTMENT") {
      return undefined;
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

    return undefined;
  }
}
