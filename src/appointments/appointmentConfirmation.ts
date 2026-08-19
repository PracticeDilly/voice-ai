import { ToolRequest } from "../backend/springBootClient.js";
import { CallSession } from "../calls/callSession.js";
import { normalizeAppointmentId } from "./appointmentId.js";
import { pendingAppointmentConfirmationError } from "./appointmentPendingAction.js";

export function validateAppointmentConfirmation(session: CallSession, tool: ToolRequest): string | undefined {
  if (tool.name !== "CONFIRM_APPOINTMENT") {
    return undefined;
  }

  const pendingError = pendingAppointmentConfirmationError(session, tool);
  if (pendingError) {
    return pendingError;
  }

  const workflow = session.workflowState;
  if (workflow?.context?.alreadyConfirmed === true) {
    return "The selected appointment is already confirmed.";
  }

  const selectedAppointmentId = normalizeAppointmentId(workflow?.context?.selectedAppointmentId);
  const requestedAppointmentId = normalizeAppointmentId(tool.arguments?.appointmentId);
  if (selectedAppointmentId && (!requestedAppointmentId || selectedAppointmentId !== requestedAppointmentId)) {
    return "The requested appointment does not match the appointment selected by the backend.";
  }

  return undefined;
}
