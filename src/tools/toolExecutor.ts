import { validateAppointmentConfirmation } from "../appointments/appointmentConfirmation.js";
import { prepareAppointmentConfirmation } from "../appointments/appointmentPendingAction.js";
import { prepareNextAppointmentLookup } from "../appointments/nextAppointment.js";
import { SpringBootClient, ToolRequest, ToolResult } from "../backend/springBootClient.js";
import { CallSession } from "../calls/callSession.js";
import { validateHandoffRequest } from "../handoff/handoffRequest.js";

const allowedTools = new Set([
  "VERIFY_PATIENT",
  "GET_NEXT_APPOINTMENT",
  "CONFIRM_APPOINTMENT",
  "GET_INSURANCE_POLICY",
  "CREATE_HANDOFF_REQUEST",
  "TRANSFER_TO_STAFF",
  "SAVE_CALL_SUMMARY"
]);

export class ToolExecutor {
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

    const preparedAppointmentTool = prepareAppointmentConfirmation(session, tool);
    const policyError = validateAppointmentConfirmation(session, preparedAppointmentTool);
    if (policyError) {
      return {
        name: tool.name,
        ok: false,
        error: policyError
      };
    }

    const handoffPolicyError = validateHandoffRequest(session, preparedAppointmentTool);
    if (handoffPolicyError) {
      return {
        name: tool.name,
        ok: false,
        error: handoffPolicyError
      };
    }

    const preparedTool = prepareNextAppointmentLookup(session, preparedAppointmentTool);
    return this.springBootClient.executeTool(session.callSid, session.officeCode, preparedTool);
  }
}
