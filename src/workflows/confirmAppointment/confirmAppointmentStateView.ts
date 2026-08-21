import { WorkflowStateView } from "../shared/workflowStateView.js";

const CONFIRM_APPOINTMENT_WORKFLOW = "CONFIRM_APPOINTMENT";

export class ConfirmAppointmentStateView {
  constructor(private readonly workflowState: WorkflowStateView) {}

  isActive(): boolean {
    return this.workflowState.workflowName() === CONFIRM_APPOINTMENT_WORKFLOW;
  }

  selectedAppointmentId(): unknown {
    return this.workflowState.selectedAppointmentId();
  }

  isAlreadyConfirmed(): boolean {
    return this.workflowState.contextValue("alreadyConfirmed") === true;
  }
}
