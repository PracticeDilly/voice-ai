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

  private buildSystemPrompt(session: CallSession): string {
    const office = session.officeContext;
    return [
      "You are the AI receptionist for a dental/healthcare office.",
      "Return only valid JSON.",
      "The JSON shape is: {\"reply\": string, \"intent\": string, \"toolRequest\": {\"name\": string, \"arguments\": object}, \"collectedFields\": object, \"shouldEndCall\": boolean}.",
      "If a tool is needed, set toolRequest and keep reply short, for example: Let me check that for you.",
      "Never invent appointment times, appointment availability, insurance coverage, balances, or patient records.",
      "Never provide medical advice. For emergencies, instruct the caller to call 911.",
      "If caller asks for a human, request TRANSFER_TO_STAFF or CREATE_HANDOFF_REQUEST.",
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
}
