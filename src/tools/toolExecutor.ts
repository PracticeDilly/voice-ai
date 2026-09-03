import { SpringBootClient, ToolRequest, ToolResult } from "../backend/springBootClient.js";
import { CallSession } from "../calls/callSession.js";
import { ConfirmAppointmentToolAdapter } from "../workflows/confirmAppointment/confirmAppointmentToolAdapter.js";
import { prepareWorkflowTool, validateWorkflowTool } from "../workflows/shared/workflowRegistry.js";

const allowedTools = new Set([
  "VERIFY_PATIENT",
  "BOOK_APPOINTMENT",
  "GET_NEXT_APPOINTMENT",
  "CONFIRM_APPOINTMENT",
  "GET_INSURANCE_POLICY",
  "TRANSFER_TO_STAFF",
  "SAVE_CALL_SUMMARY"
]);

export class ToolExecutor {
  private readonly confirmAppointmentToolAdapter = new ConfirmAppointmentToolAdapter();

  constructor(private readonly springBootClient: SpringBootClient) {}

  isAllowed(name: string): boolean {
    return allowedTools.has(name);
  }

  async execute(session: CallSession, tool: ToolRequest): Promise<ToolResult> {
    if (!this.isAllowed(tool.name)) {
      return {
        name: tool.name,
        ok: false,
        error: `Tool ${tool.name} is not allowed`
      };
    }

    const preparedAppointmentTool = this.confirmAppointmentToolAdapter.prepareTool(session, tool);
    const policyError = this.confirmAppointmentToolAdapter.validateTool(session, preparedAppointmentTool);
    if (policyError) {
      return {
        name: tool.name,
        ok: false,
        error: policyError
      };
    }

    const preparedTool = prepareWorkflowTool(session, preparedAppointmentTool);
    const workflowPolicyError = validateWorkflowTool(session, preparedTool);
    if (workflowPolicyError) {
      return {
        name: tool.name,
        ok: false,
        error: workflowPolicyError
      };
    }

    return this.springBootClient.executeTool(session.callSid, session.officeCode, preparedTool);
  }
}
