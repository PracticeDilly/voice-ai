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
    // After identity verification, the verified/corrected session values are
    // authoritative. A chained model lookup can otherwise reuse the DOB from
    // an earlier patient even after VERIFY_PATIENT accepted the correction.
    const verified = session.workflowState?.workflow === "PATIENT_VERIFICATION"
      && session.workflowState.state === "COMPLETED";
    const firstName = verified
      ? canonicalText(session.collectedFields.firstName) ?? canonicalText(argumentsRecord.firstName)
      : canonicalText(argumentsRecord.firstName) ?? canonicalText(session.collectedFields.firstName);
    const dob = verified
      ? canonicalText(session.collectedFields.dob) ?? canonicalText(argumentsRecord.dob)
      : canonicalText(argumentsRecord.dob) ?? canonicalText(session.collectedFields.dob);
    const fromNumber = canonicalText(argumentsRecord.fromNumber) ?? canonicalText(session.fromNumber);

    return {
      ...tool,
      arguments: {
        ...(firstName ? { firstName } : {}),
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
