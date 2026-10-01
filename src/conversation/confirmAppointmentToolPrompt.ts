/** Instructions specific to selecting and confirming an existing appointment. */
export function buildConfirmAppointmentToolGuidance(): string[] {
  return [
    "CONFIRM_APPOINTMENT tool guidance:",
    "- Use appointmentSelections to map the caller's date, time, or ordinal choice to a backend-provided appointmentId. When the caller identifies one appointment, set selectedAppointmentId or toolRequest.arguments.appointmentId.",
    "- For clear caller authorization to confirm an appointment, set callerAction.speechAct to AUTHORIZATION and capture the selectedAppointmentId.",
    "- Do not request CONFIRM_APPOINTMENT until one appointment is selected and workflowState allows execution. If the caller's choice is ambiguous, ask which appointment they mean."
  ];
}
