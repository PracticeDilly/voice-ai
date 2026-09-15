import type { CallSession } from "../../calls/callSession.js";

export type BookingResponsePurpose = "AWAITING_CONFIRMATION" | "HANDOFF" | "REPEAT_SLOTS" | "SCHEDULING_PREFERENCE";

export function bookingResponseContext(session: CallSession, purpose: BookingResponsePurpose) {
  return {
    purpose,
    bookingStatus: session.workflowState?.state ?? "NOT_COMPLETED",
    selectedAppointment: session.workflowState?.context,
    requiresNewCallerApproval: purpose === "AWAITING_CONFIRMATION",
    transferringToStaff: purpose === "HANDOFF",
    repeatingAvailableSlots: purpose === "REPEAT_SLOTS",
    requestingSchedulingPreference: purpose === "SCHEDULING_PREFERENCE",
    toolExecutionAllowed: false
  };
}

export const bookingResponseInstruction =
  "Write a brief, natural reply using responseContext and the conversation. Return JSON containing only reply. "
  + "For AWAITING_CONFIRMATION, the appointment is not booked; address the caller's question and seek permission for the selected appointment. "
  + "For REPEAT_SLOTS, repeat the available appointment date and times from responseContext.selectedAppointment without requesting a tool or changing the workflow. "
  + "For SCHEDULING_PREFERENCE, explain that no openings were found for the current request and ask for one specific alternative date or date range; do not request a tool or claim another search was made. "
  + "For HANDOFF, explain that office staff will assist, without claiming booking succeeded. "
  + "Do not request tools, extract fields, or infer new caller approval in this response.";
