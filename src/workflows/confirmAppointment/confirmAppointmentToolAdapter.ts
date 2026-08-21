import { ToolRequest } from "../../backend/springBootClient.js";
import { CallSession } from "../../calls/callSession.js";
import { normalizeAppointmentId } from "../../appointments/appointmentId.js";
import { WorkflowToolAdapter } from "../shared/workflowTypes.js";
import {
  confirmAppointmentPendingError,
  prepareConfirmAppointmentTool
} from "./confirmAppointmentPendingAction.js";
import { ConfirmAppointmentStateView } from "./confirmAppointmentStateView.js";
import { WorkflowStateView } from "../shared/workflowStateView.js";

export class ConfirmAppointmentToolAdapter implements WorkflowToolAdapter {
  supports(tool: ToolRequest): boolean {
    return tool.name === "CONFIRM_APPOINTMENT";
  }

  prepareTool(session: CallSession, tool: ToolRequest): ToolRequest {
    return prepareConfirmAppointmentTool(session, tool);
  }

  validateTool(session: CallSession, tool: ToolRequest): string | undefined {
    if (tool.name !== "CONFIRM_APPOINTMENT") {
      return undefined;
    }

    const pendingError = confirmAppointmentPendingError(session, tool);
    if (pendingError) {
      return pendingError;
    }

    const stateView = new ConfirmAppointmentStateView(new WorkflowStateView(session.workflowState));
    if (stateView.isAlreadyConfirmed()) {
      return "The selected appointment is already confirmed.";
    }

    const selectedAppointmentId = normalizeAppointmentId(stateView.selectedAppointmentId());
    const requestedAppointmentId = normalizeAppointmentId(tool.arguments?.appointmentId);
    if (selectedAppointmentId && (!requestedAppointmentId || selectedAppointmentId !== requestedAppointmentId)) {
      return "The requested appointment does not match the appointment selected by the backend.";
    }

    return undefined;
  }
}
