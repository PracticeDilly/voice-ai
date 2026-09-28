import type { CallSession } from "../../calls/callSession.js";

export type BookingPatientType = "NEW_PATIENT" | "RETURNING_PATIENT";

export function bookingPatientType(session: CallSession): BookingPatientType {
  return session.newPatientBookingCandidate === true
    || session.workflowState?.context?.patientType === "NEW_PATIENT"
    ? "NEW_PATIENT"
    : "RETURNING_PATIENT";
}
