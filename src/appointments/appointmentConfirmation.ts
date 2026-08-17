import { ToolRequest } from "../backend/springBootClient.js";
import { CallSession } from "../calls/callSession.js";

export function validateAppointmentConfirmation(session: CallSession, tool: ToolRequest): string | undefined {
  if (tool.name !== "CONFIRM_APPOINTMENT") {
    return undefined;
  }

  const workflow = session.workflowState;
  if (!workflow?.allowedActions?.includes(tool.name)) {
    return "Appointment confirmation is not allowed in the current workflow state.";
  }

  if (workflow.context?.alreadyConfirmed === true) {
    return "The selected appointment is already confirmed.";
  }

  const selectedAppointmentId = normalizeAppointmentId(workflow.context?.selectedAppointmentId);
  const requestedAppointmentId = normalizeAppointmentId(tool.arguments?.appointmentId);
  if (!selectedAppointmentId || !requestedAppointmentId || selectedAppointmentId !== requestedAppointmentId) {
    return "The requested appointment does not match the appointment selected by the backend.";
  }

  return undefined;
}

function normalizeAppointmentId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const normalized = BigInt(value.trim());
    return normalized > 0n ? normalized.toString() : undefined;
  }

  return undefined;
}
