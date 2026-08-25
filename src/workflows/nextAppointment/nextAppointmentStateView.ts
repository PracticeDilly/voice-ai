import { WorkflowStateView } from "../shared/workflowStateView.js";

const NEXT_APPOINTMENT_WORKFLOW = "NEXT_APPOINTMENT";

export class NextAppointmentStateView {
  constructor(private readonly workflowState: WorkflowStateView) {}

  isActive(): boolean {
    return this.workflowState.workflowName() === NEXT_APPOINTMENT_WORKFLOW;
  }

  requiredField(): string | undefined {
    return this.workflowState.requiredField();
  }

  needsInput(): boolean {
    return this.workflowState.state() === "NEEDS_INPUT";
  }

  isPatientNotFound(): boolean {
    return this.workflowState.state() === "FAILED"
      && this.workflowState.failureReason() === "PATIENT_NOT_FOUND";
  }

  allowsLookup(): boolean {
    return this.workflowState.allowedActions().includes("GET_NEXT_APPOINTMENT");
  }

  isCompleted(): boolean {
    return this.workflowState.state() === "COMPLETED";
  }
}
