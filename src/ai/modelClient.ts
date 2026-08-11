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
            currentIntent: session.currentIntent,
            conversationHistory: session.transcript.slice(-12),
            lastAssistantReply: this.findLastAssistantReply(session),
            collectedFields: session.collectedFields,
            lastToolResults: session.lastToolResults,
            latestAppointmentLookupResult: session.lastToolResults.GET_NEXT_APPOINTMENT
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
            currentIntent: session.currentIntent,
            toolResult,
            conversationHistory: session.transcript.slice(-12),
            lastAssistantReply: this.findLastAssistantReply(session),
            lastCallerReply: this.findLastCallerReply(session),
            collectedFields: session.collectedFields,
            latestAppointmentLookupResult: session.lastToolResults.GET_NEXT_APPOINTMENT
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
      "If the caller's spoken identity detail sounds cut off, unclear, fragmented, or mostly filler words, do not say no patient was found yet. Instead, ask the caller to repeat or spell that identity detail.",
      "If you are in a GET_NEXT_APPOINTMENT flow and the caller seems to correct a previously heard name, treat that as an identity correction rather than as a new request.",
      "If GET_NEXT_APPOINTMENT returns PATIENT_NOT_FOUND and the caller immediately corrects, clarifies, or spells a name, update collectedFields with the corrected values and retry GET_NEXT_APPOINTMENT once before offering staff follow-up.",
      "If GET_NEXT_APPOINTMENT returns PATIENT_NOT_FOUND right after an unclear or partial last-name response, ask the caller to repeat or spell the last name instead of claiming the provided last name was not found.",
      "If the caller provides a full corrected name after a failed lookup, update both firstName and lastName in collectedFields and use both in the retry.",
      "If the caller spells out a name letter by letter, interpret that as a correction to the existing name rather than as a new request.",
      "If GET_NEXT_APPOINTMENT returns PATIENT_NOT_FOUND after a spoken name, first say you may have heard the name incorrectly and ask the caller to spell the name you still need.",
      "Prefer this recovery order after PATIENT_NOT_FOUND: confirm or spell firstName, then confirm or spell lastName, then ask for dob only if the backend still needs more identity information.",
      "If the caller spells a corrected firstName or lastName, store the spelled version in collectedFields and use it in the next GET_NEXT_APPOINTMENT retry.",
      "After a corrected spelling is provided, retry GET_NEXT_APPOINTMENT once with the corrected identity details before offering staff follow-up.",
      "If GET_NEXT_APPOINTMENT returns PATIENT_NOT_FOUND and the caller does not provide any corrected identity details, then explain that no patient was found and offer staff follow-up if appropriate.",
      "Follow backend workflow statuses strictly for GET_NEXT_APPOINTMENT and do not invent your own verification flow.",
      "Do not claim system limitations or say records are unavailable unless the backend tool response explicitly indicates a system or availability problem.",
      "If the caller asks about office information that is already present in Office facts or Business hours, answer directly without using a tool.",
      "Do not repeat the same greeting, question, transfer offer, or confirmation twice in a row.",
      "If the last assistant reply already asked the current question or offered the same next step, acknowledge briefly and move forward instead of asking it again.",
      "Interpret each caller reply in the context of the assistant's immediately previous question and the current workflow state.",
      "When the assistant has asked for identity or verification details, assume the caller's next short or fragmentary reply is most likely part of that verification flow unless the caller clearly changes intent.",
      "Set shouldEndCall to true only when the caller is explicitly ending the conversation, not when you are merely offering a next step.",
      "If the caller clearly indicates the conversation is over or they do not need anything else, respond with a brief closing and set shouldEndCall to true unless they are also explicitly asking for office staff.",
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

  private findLastAssistantReply(session: CallSession): string | undefined {
    for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
      const turn = session.transcript[index];
      if (turn.speaker === "assistant") {
        return turn.text;
      }
    }

    return undefined;
  }

  private findLastCallerReply(session: CallSession): string | undefined {
    for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
      const turn = session.transcript[index];
      if (turn.speaker === "patient") {
        return turn.text;
      }
    }

    return undefined;
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
