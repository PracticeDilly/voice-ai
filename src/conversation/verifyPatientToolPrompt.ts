/** Instructions specific to patient identity verification. */
export function buildVerifyPatientToolGuidance(): string[] {
  return [
    "VERIFY_PATIENT tool guidance:",
    "- For appointment lookups and confirmations, verify using the caller phone number first, then first name only when needed, then date of birth only when needed. Do not disclose appointment details before workflowState.context.patientVerified is true.",
    "- If a phone-backed patient cannot be matched by first name, ask the caller to spell the first name and retry before offering staff. Do not ask for last name for returning-patient verification."
  ];
}
