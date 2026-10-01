import { ToolRequest, ToolResult } from "../../backend/springBootClient.js";
import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";

export interface ToolPolicyBoundaryContext {
  type: "CONFIRM_SELECTED_APPOINTMENT" | "CHOOSE_CONFIRMABLE_APPOINTMENT" | "CONFIRMATION_COMPLETED" | "ASK_CALLER_TO_SPELL_NAME" | "BOOKING_CONFIRMATION" | "BOOKING_AVAILABILITY_ALTERNATIVE" | "BOOKING_SLOT_REPEAT" | "NEW_PATIENT_CONFIRMATION" | "IDENTITY_CORRECTION";
  selectedAppointment?: {
    appointmentId: unknown;
    appointmentDate?: string;
    doctorName?: string;
  };
  options?: Array<{
    appointmentId: unknown;
    appointmentDate?: string;
    doctorName?: string;
  }>;
  identity?: {
    firstName?: string;
    lastName?: string;
  };
}

export interface ToolPolicyDecision {
  overrideResult?: ModelTurnResult;
  instruction?: string;
  repromptContext?: ToolPolicyBoundaryContext;
}

export interface WorkflowFollowupDecision {
  disposition: "RETURN" | "CONTINUE_TOOL_CHAIN";
  result: ModelTurnResult;
}

export interface WorkflowToolResultContext {
  callerSelectedAvailableSlot: boolean;
  confirmedAppointmentDate?: string;
}

export interface WorkflowCallerTurnDecision {
  reply: string;
  source: string;
}

export interface WorkflowErrorDecision {
  staffTransferReason: string;
}

export interface WorkflowToolAdapter {
  supports(tool: ToolRequest): boolean;
  prepareTool(session: CallSession, tool: ToolRequest): ToolRequest;
  validateTool?(session: CallSession, tool: ToolRequest): string | undefined;
}

export interface WorkflowModelLifecycle {
  constrainResult?(session: CallSession, result: ModelTurnResult): void;
  synchronizeData?(session: CallSession, result: ModelTurnResult, callerText?: string): void;
  synchronizeResult?(session: CallSession, result: ModelTurnResult): void;
  hydrateContext?(session: CallSession): void;
  shouldContinuePolicyReprompt?(session: CallSession, result: ModelTurnResult): boolean;
}

export interface ConversationWorkflow {
  name: string;
  toolAdapter?: WorkflowToolAdapter;
  modelLifecycle?: WorkflowModelLifecycle;
  limitToolChain?(session: CallSession, result: ModelTurnResult, toolChainDepth: number): ModelTurnResult | undefined;
  prepareModelResult?(session: CallSession, callerText: string, result: ModelTurnResult): ModelTurnResult;
  prepareReply?(session: CallSession, reply: string): string;
  startNewPatientBooking?(session: CallSession): void;
  handleCallerTurn?(session: CallSession, callerText: string): WorkflowCallerTurnDecision | undefined;
  handleBookingEntry?(session: CallSession, callerText: string, result: ModelTurnResult): WorkflowCallerTurnDecision | undefined;
  handleError?(session: CallSession, error: unknown): WorkflowErrorDecision | undefined;
  prepareToolRequest?(session: CallSession, result: ModelTurnResult): Promise<ModelTurnResult>;
  prepareFollowup?(session: CallSession, result: ModelTurnResult, followups: number): Promise<WorkflowFollowupDecision>;
  callerSelectedAvailableSlot?(session: CallSession, result: ModelTurnResult): boolean;
  resolveToolResult?(
    session: CallSession,
    request: ModelTurnResult,
    toolResult: unknown,
    context: WorkflowToolResultContext
  ): Promise<ModelTurnResult | undefined>;
  synchronizeToolResult?(
    session: CallSession,
    toolName: string,
    toolResult: ToolResult,
    activeIntent: string | undefined,
    request: ModelTurnResult
  ): Partial<WorkflowToolResultContext> | void;
  consumeToolResult?(session: CallSession, toolName: string, toolResult: ToolResult): void;
  invalidateToolResultCache?(session: CallSession, toolName: string, toolResult: ToolResult): void;
  resolvePolicyReprompt?(session: CallSession, context: ToolPolicyBoundaryContext): Promise<ModelTurnResult | undefined>;
  applyTurnPolicy?(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined;
  applyToolResultPolicy?(
    session: CallSession,
    toolName: string,
    toolResult: unknown,
    request?: ModelTurnResult
  ): ToolPolicyDecision | undefined;
}
