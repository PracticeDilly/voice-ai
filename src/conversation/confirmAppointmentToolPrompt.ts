/** Instructions specific to selecting and confirming an existing appointment. */
export function buildConfirmAppointmentToolGuidance(): string[] {
  return [
    "CONFIRM_APPOINTMENT tool guidance:",
    "- Use appointmentSelections to map the caller's date, time, or ordinal choice to a backend-provided appointmentId. When the caller identifies one appointment, set selectedAppointmentId or toolRequest.arguments.appointmentId.",
    "- When offering to confirm a specific unconfirmed appointment from a successful verified lookup, include its backend ID in confirmationOfferAppointmentId and ask for permission in reply. An offer is not authorization. Omit that field unless this reply actually offers confirmation. Node records the offer so the next acceptance can execute without asking again.",
    "- When the caller accepts a pending confirmation offer, use intent CONFIRM_APPOINTMENT, callerAction.speechAct AUTHORIZATION, authorization.stateChangingAction CONFIRM_APPOINTMENT, and authorization.isExplicit true. Preserve the selected appointment; do not keep a stale NEXT_APPOINTMENT intent.",
    "- For clear caller authorization to confirm an appointment, set callerAction.speechAct to AUTHORIZATION and capture the selectedAppointmentId.",
    "- Do not request CONFIRM_APPOINTMENT until one appointment is selected and workflowState allows execution. If the caller's choice is ambiguous, ask which appointment they mean."
  ];
}
