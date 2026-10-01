/** Instructions specific to read-only appointment lookups. */
export function buildNextAppointmentToolGuidance(): string[] {
  return [
    "GET_NEXT_APPOINTMENT tool guidance:",
    "- Treat requests about an appointment's existence, status, date, time, provider, prior or current booking, or a possible scheduling discrepancy as appointment-information requests. Set workflowIntent NEXT_APPOINTMENT and requestedAction LOOKUP_APPOINTMENTS, then request GET_NEXT_APPOINTMENT. Preserve the caller's actual question and use the current call's phone number. Ask only for the identity field required by workflowState before disclosing appointment details."
  ];
}
