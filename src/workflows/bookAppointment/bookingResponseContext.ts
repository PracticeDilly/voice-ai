import type { CallSession } from "../../calls/callSession.js";

export type BookingResponsePurpose = "AWAITING_CONFIRMATION" | "HANDOFF" | "REPEAT_SLOTS" | "SCHEDULING_PREFERENCE" | "APPOINTMENT_TYPE_CLARIFICATION";

const MAX_SLOTS_IN_REPEAT_RESPONSE = 4;

export function bookingResponseContext(session: CallSession, purpose: BookingResponsePurpose) {
  const workflowContext = session.workflowState?.context;
  const selectedAppointment = purpose === "REPEAT_SLOTS"
    ? boundedSlotResponseContext(workflowContext)
    : workflowContext;

  return {
    purpose,
    bookingStatus: session.workflowState?.state ?? "NOT_COMPLETED",
    selectedAppointment,
    requiresNewCallerApproval: purpose === "AWAITING_CONFIRMATION",
    transferringToStaff: purpose === "HANDOFF",
    repeatingAvailableSlots: purpose === "REPEAT_SLOTS",
    requestingSchedulingPreference: purpose === "SCHEDULING_PREFERENCE",
    requestingAppointmentTypeClarification: purpose === "APPOINTMENT_TYPE_CLARIFICATION",
    toolExecutionAllowed: false
  };
}

function boundedSlotResponseContext(
  context: NonNullable<CallSession["workflowState"]>["context"]
): typeof context {
  if (!context || !Array.isArray(context.slots) || context.slots.length <= MAX_SLOTS_IN_REPEAT_RESPONSE) {
    return context;
  }

  return {
    ...context,
    slots: context.slots.slice(0, MAX_SLOTS_IN_REPEAT_RESPONSE),
    additionalSlotCount: context.slots.length - MAX_SLOTS_IN_REPEAT_RESPONSE
  };
}

export const bookingResponseInstruction =
  "Write a brief, natural reply using responseContext and the conversation. Return JSON containing only reply. "
  + "For AWAITING_CONFIRMATION, the appointment is not booked; address the caller's question and seek permission for the selected appointment. "
  + "For REPEAT_SLOTS, use only responseContext.selectedAppointment.slots, never list more than 4 slots, and if additionalSlotCount is present say that more times are available and ask whether the caller wants a later time or a specific preference. Do not request a tool or change the workflow. "
  + "For SCHEDULING_PREFERENCE, explain that no openings were found for the current request and ask for one specific alternative date or date range; do not request a tool or claim another search was made. "
  + "For APPOINTMENT_TYPE_CLARIFICATION, ask one concise patient-friendly question about the treatment needed because the appointment type could not be safely resolved; do not mention IDs or ask the caller to choose an internal appointment type. Do not request a tool. "
  + "For HANDOFF, explain that office staff will assist, without claiming booking succeeded. "
  + "Do not request tools, extract fields, or infer new caller approval in this response.";
