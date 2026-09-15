import type { CallSession, OfficeAppointmentTypeContext } from "../../calls/callSession.js";

export type BookingPatientType = "NEW_PATIENT" | "RETURNING_PATIENT";

export function bookingPatientType(session: CallSession): BookingPatientType {
  return session.newPatientBookingCandidate === true
    || session.workflowState?.context?.patientType === "NEW_PATIENT"
    ? "NEW_PATIENT"
    : "RETURNING_PATIENT";
}

export function eligibleAppointmentTypes(session: CallSession): OfficeAppointmentTypeContext[] {
  return (session.officeContext?.appointmentTypes?.[bookingPatientType(session)] ?? [])
    .filter((type) => Number.isInteger(type.appointmentTypeId));
}

export function isEligibleAppointmentTypeId(session: CallSession, value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && eligibleAppointmentTypes(session).some((type) => type.appointmentTypeId === value);
}

export function bookingReason(session: CallSession, candidate?: unknown): string | undefined {
  const value = candidate
    ?? session.collectedFields.bookingReason
    ?? session.workflowState?.context?.bookingReason;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
