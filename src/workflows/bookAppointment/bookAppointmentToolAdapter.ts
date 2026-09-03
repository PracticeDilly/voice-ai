import { ToolRequest } from "../../backend/springBootClient.js";
import { CallSession } from "../../calls/callSession.js";
import { logger } from "../../utils/logger.js";
import { WorkflowToolAdapter } from "../shared/workflowTypes.js";

const bookingFieldNames = [
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
];

export class BookAppointmentToolAdapter implements WorkflowToolAdapter {
  supports(tool: ToolRequest): boolean {
    return tool.name === "BOOK_APPOINTMENT";
  }

  prepareTool(session: CallSession, tool: ToolRequest): ToolRequest {
    const preparedArguments: Record<string, unknown> = {};
    for (const fieldName of bookingFieldNames) {
      const value = tool.arguments?.[fieldName] ?? session.collectedFields[fieldName];
      if (value !== undefined && value !== null && value !== "") {
        preparedArguments[fieldName] = value;
      }
    }

    if (session.fromNumber && preparedArguments.fromNumber === undefined) {
      preparedArguments.fromNumber = session.fromNumber;
    }

    addKnownSlotField(preparedArguments, "slotDate", tool.arguments?.slotDate, session.workflowState?.context?.slotDate);
    addKnownSlotField(preparedArguments, "slotTime", tool.arguments?.slotTime, session.workflowState?.context?.slotTime);
    logger.debug("Prepared booking tool arguments", {
      callSid: session.callSid,
      officeCode: session.officeCode,
      hasReason: preparedArguments.reason !== undefined,
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

function addKnownSlotField(
  target: Record<string, unknown>,
  fieldName: "slotDate" | "slotTime",
  argumentValue: unknown,
  contextValue: unknown
): void {
  const value = argumentValue ?? contextValue;
  if (value !== undefined && value !== null && value !== "") {
    target[fieldName] = value;
  }
}
