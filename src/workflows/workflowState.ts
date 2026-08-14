export type WorkflowStateName =
  | "NEEDS_INPUT"
  | "SELECT_OPTION"
  | "REQUIRES_CONFIRMATION"
  | "READY_TO_EXECUTE"
  | "COMPLETED"
  | "FAILED"
  | "HANDOFF_REQUIRED";

export interface WorkflowEnvelope {
  contractVersion: number;
  workflow: string;
  state: WorkflowStateName | string;
  requiredField?: string | null;
  allowedActions?: string[];
  context?: WorkflowContext;
  failureReason?: string | null;
}

export interface WorkflowContext extends Record<string, unknown> {
  patientVerified?: boolean;
  canDisclosePatientData?: boolean;
  appointments?: unknown[];
  selectedAppointmentId?: unknown;
  requiresExplicitConfirmation?: boolean;
}

interface WorkflowEnvelopeCandidate extends Record<string, unknown> {
  workflow?: unknown;
  state?: unknown;
  contractVersion?: unknown;
  requiredField?: unknown;
  allowedActions?: unknown;
  context?: unknown;
  failureReason?: unknown;
}

export function extractWorkflowEnvelope(
  toolResult: unknown
): WorkflowEnvelope | undefined {
  const wrapper = asRecord(toolResult);
  const nestedWorkflowState = normalizeWorkflowEnvelopeCandidate(wrapper?.workflowState);
  if (nestedWorkflowState) {
    return nestedWorkflowState;
  }

  const directCandidate = normalizeWorkflowEnvelopeCandidate(toolResult);
  if (directCandidate) {
    return directCandidate;
  }

  const nestedCandidate = normalizeWorkflowEnvelopeCandidate(wrapper?.data);
  if (nestedCandidate) {
    return nestedCandidate;
  }

  const nestedDataWorkflowState = normalizeWorkflowEnvelopeCandidate(asRecord(wrapper?.data)?.workflowState);
  if (nestedDataWorkflowState) {
    return nestedDataWorkflowState;
  }

  return undefined;
}

function normalizeWorkflowEnvelopeCandidate(value: unknown): WorkflowEnvelope | undefined {
  const candidate = asRecord(value) as WorkflowEnvelopeCandidate | undefined;
  if (!candidate || typeof candidate.workflow !== "string" || typeof candidate.state !== "string") {
    return undefined;
  }

  return sanitizeWorkflowEnvelope({
    contractVersion: typeof candidate.contractVersion === "number" ? candidate.contractVersion : 1,
    workflow: normalizeWorkflowName(candidate.workflow) ?? candidate.workflow,
    state: candidate.state,
    requiredField: normalizeOptionalString(candidate.requiredField),
    allowedActions: normalizeStringArray(candidate.allowedActions),
    context: asWorkflowContext(candidate.context),
    failureReason: normalizeOptionalString(candidate.failureReason)
  });
}

function sanitizeWorkflowEnvelope(envelope: WorkflowEnvelope): WorkflowEnvelope {
  const context = envelope.context ? { ...envelope.context } : undefined;
  if (!context) {
    return envelope;
  }

  if (envelope.state === "SELECT_OPTION") {
    context.selectedAppointmentId = null;
  }

  if (envelope.state === "COMPLETED") {
    delete context.appointments;
  }

  return {
    ...envelope,
    context
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asWorkflowContext(value: unknown): WorkflowContext | undefined {
  const context = asRecord(value);
  if (!context) {
    return undefined;
  }

  return context as WorkflowContext;
}

function normalizeOptionalString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeWorkflowName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  const aliasMap: Record<string, string> = {
    CONFIRM_APPOINTMENT: "CONFIRM_APPOINTMENT",
    NEXT_APPOINTMENT: "NEXT_APPOINTMENT",
    CANCEL_APPOINTMENT: "CANCEL_APPOINTMENT",
    RESCHEDULE_APPOINTMENT: "RESCHEDULE_APPOINTMENT",
    TRANSFER_TO_STAFF: "TRANSFER_TO_STAFF",
    HANDOFF_TO_STAFF: "TRANSFER_TO_STAFF",
    CONFIRM_APPOINTMENT_INTENT: "CONFIRM_APPOINTMENT"
  };

  if (normalized in aliasMap) {
    return aliasMap[normalized];
  }

  return normalized.replace(/\s+/g, "_");
}
