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

interface LegacyAppointmentMetadata {
  multipleFutureAppointments?: boolean;
  alreadyConfirmed?: boolean | null;
}

interface LegacyAppointmentLookupResult {
  workflowStatus?: string;
  appointmentId?: unknown;
  upcomingAppointments?: unknown;
  collectedFields?: Record<string, unknown>;
  metadata?: LegacyAppointmentMetadata;
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
  toolResult: unknown,
  fallbackWorkflow?: string
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

  const toolName = typeof wrapper?.name === "string" ? wrapper.name : undefined;
  if (!toolName) {
    return undefined;
  }

  return legacyWorkflowEnvelope(toolName, wrapper?.data, normalizeWorkflowName(fallbackWorkflow));
}

function normalizeWorkflowEnvelopeCandidate(value: unknown): WorkflowEnvelope | undefined {
  const candidate = asRecord(value) as WorkflowEnvelopeCandidate | undefined;
  if (!candidate || typeof candidate.workflow !== "string" || typeof candidate.state !== "string") {
    return undefined;
  }

  return {
    contractVersion: typeof candidate.contractVersion === "number" ? candidate.contractVersion : 1,
    workflow: normalizeWorkflowName(candidate.workflow) ?? candidate.workflow,
    state: candidate.state,
    requiredField: normalizeOptionalString(candidate.requiredField),
    allowedActions: normalizeStringArray(candidate.allowedActions),
    context: asWorkflowContext(candidate.context),
    failureReason: normalizeOptionalString(candidate.failureReason)
  };
}

function legacyWorkflowEnvelope(
  toolName: string,
  data: unknown,
  fallbackWorkflow?: string
): WorkflowEnvelope | undefined {
  if (toolName === "GET_NEXT_APPOINTMENT") {
    return legacyNextAppointmentEnvelope(data, fallbackWorkflow);
  }

  if (toolName === "CONFIRM_APPOINTMENT") {
    return legacyConfirmAppointmentEnvelope(data, fallbackWorkflow);
  }

  return undefined;
}

function legacyNextAppointmentEnvelope(
  data: unknown,
  fallbackWorkflow?: string
): WorkflowEnvelope | undefined {
  const lookup = asRecord(data) as LegacyAppointmentLookupResult | undefined;
  if (!lookup || typeof lookup.workflowStatus !== "string") {
    return undefined;
  }

  const workflow = normalizeWorkflowName(fallbackWorkflow) ?? "CONFIRM_APPOINTMENT";
  const context: WorkflowContext = {
    patientVerified: false,
    canDisclosePatientData: false,
    appointments: [],
    selectedAppointmentId: null,
    requiresExplicitConfirmation: true
  };
  if (Array.isArray(lookup.upcomingAppointments)) {
    context.appointments = lookup.upcomingAppointments;
  }
  if (lookup.appointmentId !== undefined) {
    context.selectedAppointmentId = lookup.appointmentId;
  }
  if (lookup.metadata) {
    context.metadata = lookup.metadata;
    if (lookup.metadata.alreadyConfirmed !== undefined) {
      context.alreadyConfirmed = lookup.metadata.alreadyConfirmed;
    }
  }
  if (lookup.collectedFields) {
    context.collectedFields = lookup.collectedFields;
  }

  switch (lookup.workflowStatus) {
    case "NEEDS_FIRST_NAME":
      return {
        contractVersion: 1,
        workflow,
        state: "NEEDS_INPUT",
        requiredField: "firstName",
        allowedActions: ["GET_NEXT_APPOINTMENT"],
        context
      };
    case "NEEDS_DOB":
      return {
        contractVersion: 1,
        workflow,
        state: "NEEDS_INPUT",
        requiredField: "dob",
        allowedActions: ["GET_NEXT_APPOINTMENT"],
        context
      };
    case "PATIENT_AMBIGUOUS":
      return {
        contractVersion: 1,
        workflow,
        state: "HANDOFF_REQUIRED",
        allowedActions: ["CREATE_HANDOFF_REQUEST", "TRANSFER_TO_STAFF"],
        failureReason: "PATIENT_AMBIGUOUS",
        context
      };
    case "NO_UPCOMING_APPOINTMENT":
      return {
        contractVersion: 1,
        workflow,
        state: "FAILED",
        allowedActions: ["CREATE_HANDOFF_REQUEST"],
        failureReason: "NO_UPCOMING_APPOINTMENT",
        context: {
          ...context,
          patientVerified: true,
          canDisclosePatientData: true
        }
      };
    case "NEXT_APPOINTMENT_FOUND":
      return {
        contractVersion: 1,
        workflow,
        state: lookup.metadata?.multipleFutureAppointments ? "SELECT_OPTION" : "REQUIRES_CONFIRMATION",
        allowedActions: ["CONFIRM_APPOINTMENT"],
        context: {
          ...context,
          patientVerified: true,
          canDisclosePatientData: true
        }
      };
    case "PATIENT_NOT_FOUND":
      return {
        contractVersion: 1,
        workflow,
        state: "FAILED",
        allowedActions: ["GET_NEXT_APPOINTMENT", "CREATE_HANDOFF_REQUEST"],
        failureReason: "PATIENT_NOT_FOUND",
        context
      };
    default:
      return undefined;
  }
}

function legacyConfirmAppointmentEnvelope(
  data: unknown,
  fallbackWorkflow?: string
): WorkflowEnvelope | undefined {
  const confirmation = asRecord(data);
  if (!confirmation || typeof confirmation.workflowStatus !== "string") {
    return undefined;
  }

  if (confirmation.workflowStatus !== "APPOINTMENT_CONFIRMED") {
    return undefined;
  }

  return {
    contractVersion: 1,
    workflow: normalizeWorkflowName(fallbackWorkflow) ?? "CONFIRM_APPOINTMENT",
    state: "COMPLETED",
    allowedActions: [],
    context: {
      appointmentId: confirmation.appointmentId,
      alreadyConfirmed: confirmation.alreadyConfirmed === true,
      confirmed: confirmation.confirmed === true
    }
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
