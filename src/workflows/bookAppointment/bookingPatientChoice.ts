import type { ModelTurnResult } from "../../conversation/modelClient.js";
import type { PatientTypeChoice } from "../shared/callerActionDecision.js";

export type BookingPatientChoice = PatientTypeChoice;

export function bookingPatientChoiceFromModel(result: ModelTurnResult): BookingPatientChoice | undefined {
  const choice = result.callerAction?.patientTypeChoice;
  return choice === "NEW_PATIENT" || choice === "RETURNING_PATIENT" ? choice : undefined;
}
