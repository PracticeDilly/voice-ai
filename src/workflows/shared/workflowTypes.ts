import { ToolRequest } from "../../backend/springBootClient.js";
import { CallSession } from "../../calls/callSession.js";
import { ModelTurnResult } from "../../conversation/modelClient.js";

export interface ToolPolicyBoundaryContext {
  type: "CONFIRM_SELECTED_APPOINTMENT" | "CHOOSE_CONFIRMABLE_APPOINTMENT" | "CONFIRMATION_COMPLETED" | "ASK_CALLER_TO_SPELL_NAME";
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

export interface WorkflowToolAdapter {
  supports(tool: ToolRequest): boolean;
  prepareTool(session: CallSession, tool: ToolRequest): ToolRequest;
  validateTool?(session: CallSession, tool: ToolRequest): string | undefined;
}

export interface ConversationWorkflow {
  name: string;
  toolAdapter?: WorkflowToolAdapter;
  applyTurnPolicy?(session: CallSession, result: ModelTurnResult): ToolPolicyDecision | undefined;
  applyToolResultPolicy?(session: CallSession, toolName: string, toolResult: unknown): ToolPolicyDecision | undefined;
}
