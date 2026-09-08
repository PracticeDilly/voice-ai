import type { CallSession } from "../../calls/callSession.js";

export type BookingResponsePurpose = "AWAITING_CONFIRMATION" | "HANDOFF";

export function bookingResponseContext(session: CallSession, purpose: BookingResponsePurpose) {
  return {
    purpose,
    bookingStatus: session.workflowState?.state ?? "NOT_COMPLETED",
    selectedAppointment: session.workflowState?.context,
    requiresNewCallerApproval: purpose === "AWAITING_CONFIRMATION",
    transferringToStaff: purpose === "HANDOFF",
    toolExecutionAllowed: false
  };
}

export const bookingResponseInstruction =
  "Write a brief, natural reply using responseContext and the conversation. Return JSON containing only reply. "
  + "For AWAITING_CONFIRMATION, the appointment is not booked; address the caller's question and seek permission for the selected appointment. "
  + "For HANDOFF, explain that office staff will assist, without claiming booking succeeded. "
  + "Do not request tools, extract fields, or infer new caller approval in this response.";
