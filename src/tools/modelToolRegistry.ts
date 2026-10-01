export interface ModelToolContract {
  name: string;
  purpose: string;
  requiredArguments?: string[];
  optionalArguments?: string[];
}

/**
 * Single source of truth for tools the conversation model may request.
 * Internal lifecycle work, such as post-call summary persistence, is not listed.
 */
export const modelToolContracts: ModelToolContract[] = [
  {
    name: "VERIFY_PATIENT",
    purpose: "Resolve and verify the caller before any patient-specific appointment workflow.",
    optionalArguments: ["firstName", "dob", "fromNumber"]
  },
  {
    name: "GET_NEXT_APPOINTMENT",
    purpose: "Read-only lookup for verified or in-progress patient appointment workflows.",
    optionalArguments: ["firstName", "dob", "fromNumber"]
  },
  {
    name: "BOOK_APPOINTMENT",
    purpose: "Book an appointment for a verified returning patient or a newly collected patient record. The model must resolve the appointmentTypeId from the eligible office catalog; the backend validates and executes the selected option.",
    requiredArguments: ["firstName", "dob", "bookingReason", "appointmentTypeId"],
    optionalArguments: ["fromNumber", "patientPhone", "patientEmail", "gender", "providerName", "datePreference", "timePreference", "slotDate", "slotTime", "fromDate", "toDate", "callerConfirmedBooking"]
  },
  {
    name: "CONFIRM_APPOINTMENT",
    purpose: "State-changing appointment confirmation. Only request after Node pendingActions show the selected appointment is ready.",
    requiredArguments: ["appointmentId"],
    optionalArguments: ["callerConfirmedSelectedAppointment"]
  },
  {
    name: "GET_INSURANCE_POLICY",
    purpose: "Read-only office insurance policy lookup."
  },
  {
    name: "TRANSFER_TO_STAFF",
    purpose: "Transfer the caller to office staff after an explicit caller request or consent to a staff-transfer offer."
  }
];

const modelToolNames: ReadonlySet<string> = new Set(modelToolContracts.map((tool) => tool.name));

export function isModelToolAllowed(name: string): boolean {
  return modelToolNames.has(name);
}
