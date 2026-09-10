import { ToolRequest } from "../../backend/springBootClient.js";
import { CallSession } from "../../calls/callSession.js";
import { WorkflowToolAdapter } from "../shared/workflowTypes.js";

export class NextAppointmentToolAdapter implements WorkflowToolAdapter {
  supports(tool: ToolRequest): boolean {
    return tool.name === "GET_NEXT_APPOINTMENT";
  }

  prepareTool(session: CallSession, tool: ToolRequest): ToolRequest {
    if (!this.supports(tool)) {
      return tool;
    }

    const argumentsRecord = tool.arguments ?? {};
    const firstName = canonicalText(argumentsRecord.firstName) ?? canonicalText(session.collectedFields.firstName);
    const lastName = canonicalText(argumentsRecord.lastName) ?? canonicalText(session.collectedFields.lastName);
    const dob = canonicalText(argumentsRecord.dob)
      ?? canonicalText(argumentsRecord.dateOfBirth)
      ?? canonicalText(session.collectedFields.dob)
      ?? canonicalText(session.collectedFields.dateOfBirth);
    const fromNumber = canonicalText(argumentsRecord.fromNumber) ?? canonicalText(session.fromNumber);

    return {
      ...tool,
      arguments: {
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {}),
        ...(dob ? { dob } : {}),
        ...(fromNumber ? { fromNumber } : {})
      }
    };
  }
}

function canonicalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
