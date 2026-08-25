import { WorkflowEnvelope } from "../workflowState.js";

export class WorkflowStateView {
  constructor(private readonly workflowState?: WorkflowEnvelope) {}

  workflowName(): string | undefined {
    return this.workflowState?.workflow;
  }

  state(): string | undefined {
    return this.workflowState?.state;
  }

  requiredField(): string | undefined {
    const requiredField = this.workflowState?.requiredField;
    return typeof requiredField === "string" && requiredField.trim().length > 0
      ? requiredField
      : undefined;
  }

  failureReason(): string | null | undefined {
    return this.workflowState?.failureReason;
  }

  allowedActions(): string[] {
    return this.workflowState?.allowedActions ?? [];
  }

  allowsAction(actionName: string): boolean {
    return this.allowedActions().includes(actionName);
  }

  contextValue<T = unknown>(key: string): T | undefined {
    return this.workflowState?.context?.[key] as T | undefined;
  }

  appointments(): unknown[] {
    const appointments = this.workflowState?.context?.appointments;
    return Array.isArray(appointments) ? appointments : [];
  }

  selectedAppointmentId(): unknown {
    return this.workflowState?.context?.selectedAppointmentId;
  }
}
