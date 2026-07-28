import { CallSession } from "../sessions/callSession.js";
import { SpringBootClient, ToolRequest, ToolResult } from "../clients/springBootClient.js";

const allowedTools = new Set([
  "VERIFY_PATIENT",
  "GET_NEXT_APPOINTMENT",
  "CONFIRM_APPOINTMENT",
  "GET_INSURANCE_POLICY",
  "CREATE_HANDOFF_REQUEST",
  "TRANSFER_TO_STAFF",
  "SAVE_CALL_SUMMARY"
]);

export class ToolRegistry {
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

    return this.springBootClient.executeTool(session.callSid, session.officeCode, tool);
  }
}
