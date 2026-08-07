import OpenAI from "openai";
import { config } from "../config/env.js";
import { CallSession } from "../sessions/callSession.js";
import { ToolRequest } from "../clients/springBootClient.js";

export interface ModelTurnResult {
  reply?: string;
  toolRequest?: ToolRequest;
  intent?: string;
  collectedFields?: Record<string, unknown>;
  shouldEndCall?: boolean;
}

export interface ModelCallSummary {
  summaryText: string;
  primaryIntent?: string;
  staffFollowupRequired?: boolean;
  priority?: string;
}

export class ModelClient {
  private readonly client = new OpenAI({
    apiKey: config.OPENAI_API_KEY
  });

  async nextTurn(session: CallSession, callerText: string): Promise<ModelTurnResult> {
    const response = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: this.buildSystemPrompt(session)
        },
        {
          role: "user",
          content: JSON.stringify({
            callerText,
            conversationHistory: session.transcript.slice(-12),
            collectedFields: session.collectedFields,
            lastToolResults: session.lastToolResults
          })
        }
      ]
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    return this.parseModelResult(content);
  }

  async continueWithToolResult(session: CallSession, toolResult: unknown): Promise<ModelTurnResult> {
    const response = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: this.buildSystemPrompt(session)
        },
        {
          role: "user",
          content: JSON.stringify({
            instruction: "Use this tool result to produce the next caller-facing response.",
            toolResult,
            conversationHistory: session.transcript.slice(-12),
            collectedFields: session.collectedFields
          })
        }
      ]
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    return this.parseModelResult(content);
  }

  async summarizeCall(session: CallSession): Promise<ModelCallSummary> {
    const response = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You summarize dental/healthcare AI receptionist calls for office staff.",
            "Return only valid JSON.",
            "The JSON shape is: {\"summaryText\": string, \"primaryIntent\": string, \"staffFollowupRequired\": boolean, \"priority\": \"LOW\"|\"NORMAL\"|\"HIGH\"}.",
            "summaryText must be a short human-readable summary for office staff, usually 1 to 3 sentences.",
            "Do not invent patient data or appointment confirmations."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            officeCode: session.officeCode,
            officeName: session.officeContext?.officeName,
            currentIntent: session.currentIntent,
            collectedFields: session.collectedFields,
            lastToolResults: session.lastToolResults,
            transcript: session.transcript
          })
        }
      ]
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    return this.parseCallSummary(content, session);
  }

  private buildSystemPrompt(session: CallSession): string {
    const office = session.officeContext;
    return [
      "You are the AI receptionist for a dental/healthcare office.",
      "Return only valid JSON.",
      "The JSON shape is: {\"reply\": string, \"intent\": string, \"toolRequest\": {\"name\": string, \"arguments\": object}, \"collectedFields\": object, \"shouldEndCall\": boolean}.",
      "If a tool is needed, set toolRequest and keep reply short, for example: Let me check that for you.",
      "For GET_NEXT_APPOINTMENT, the backend will first try to match the caller using the live fromNumber automatically.",
      "If the tool response says more identity information is needed, ask for the next missing field only: lastName first, then firstName, then date of birth.",
      "When calling GET_NEXT_APPOINTMENT, include any known fields in toolRequest.arguments using keys lastName, firstName, and dob.",
      "When a tool response says another field is needed, ask only for that field and preserve previously collected values in collectedFields.",
      "If the tool response says PATIENT_NOT_FOUND, do not continue identity collection. Tell the caller no patient was found and offer staff follow-up if appropriate.",
      "Follow backend workflow statuses strictly for GET_NEXT_APPOINTMENT and do not invent your own verification flow.",
      "If the caller asks about office information that is already present in Office facts or Business hours, answer directly without using a tool.",
      "Never invent appointment times, appointment availability, insurance coverage, balances, or patient records.",
      "Never provide medical advice. For emergencies, instruct the caller to call 911.",
      "If caller asks for a human or live staff, request TRANSFER_TO_STAFF and set shouldEndCall to true.",
      "If caller asks for staff follow-up but not a live transfer, request CREATE_HANDOFF_REQUEST.",
      `Office code: ${session.officeCode}`,
      `Office name: ${office?.officeName ?? "Unknown"}`,
      `Office phone number: ${office?.phoneNumber ?? session.toNumber ?? "Not provided"}`,
      `Timezone: ${office?.timezone ?? config.AI_DEFAULT_OFFICE_TIMEZONE}`,
      `AI mode: ${office?.aiMode ?? "UNKNOWN"}`,
      `Greeting: ${office?.aiGreeting ?? "Not provided"}`,
      `Business hours: ${office?.businessHoursSummary ?? "Not provided"}`,
      `Allowed actions: ${(office?.allowedActions ?? []).join(", ")}`,
      `Supported intents: ${(office?.supportedIntents ?? []).join(", ")}`,
      `Handoff policy: ${office?.handoffPolicy ?? "Transfer to staff when requested or uncertain."}`,
      `Emergency message: ${office?.emergencyMessage ?? "If this is a medical emergency, please hang up and call 911."}`,
      `Office facts: ${(office?.facts ?? []).join(" | ")}`
    ].join("\n");
  }

  private parseModelResult(content: string): ModelTurnResult {
    try {
      const parsed = JSON.parse(content) as ModelTurnResult;
      return parsed;
    } catch {
      return {
        reply: "I am sorry, I had trouble understanding that. Let me connect you with the office.",
        toolRequest: {
          name: "CREATE_HANDOFF_REQUEST",
          arguments: {
            reason: "MODEL_RESPONSE_PARSE_FAILED"
          }
        },
        intent: "HANDOFF_TO_STAFF"
      };
    }
  }

  private parseCallSummary(content: string, session: CallSession): ModelCallSummary {
    try {
      const parsed = JSON.parse(content) as ModelCallSummary;
      const summaryText = parsed.summaryText?.trim() || "AI receptionist call completed. Staff can review the transcript for details.";
      return {
        ...parsed,
        summaryText,
        primaryIntent: parsed.primaryIntent ?? session.currentIntent,
        staffFollowupRequired: parsed.staffFollowupRequired ?? false,
        priority: parsed.priority ?? "NORMAL"
      };
    } catch {
      const summaryText = "AI receptionist call completed. Staff can review the transcript for details.";
      return {
        summaryText,
        primaryIntent: session.currentIntent,
        staffFollowupRequired: true,
        priority: "NORMAL"
      };
    }
  }
}
