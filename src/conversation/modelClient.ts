import OpenAI from "openai";
import { z } from "zod";
import { config } from "../config/env.js";
import { ToolRequest } from "../backend/springBootClient.js";
import { CallSession } from "../calls/callSession.js";
import { ToolPolicyBoundaryContext } from "../workflows/shared/workflowTypes.js";
import type { CallerActionDecision } from "../workflows/shared/callerActionDecision.js";
import { buildSystemPrompt } from "./promptBuilder.js";
import { BookingWorkflowError, bookingModelContractError } from "../workflows/bookAppointment/bookingModelContract.js";
import { bookingResponseContext, bookingResponseInstruction, BookingResponsePurpose } from "../workflows/bookAppointment/bookingResponseContext.js";
import {
  bookingReason,
  eligibleAppointmentTypes,
  isEligibleAppointmentTypeId
} from "../workflows/bookAppointment/appointmentTypeSelection.js";
import { bookingPatientType } from "../workflows/shared/patientType.js";
import { logger } from "../utils/logger.js";
import { newPatientDataConfirmationContext } from "../workflows/shared/newPatientDataConfirmation.js";

const callerActionSchema = z.object({
  speechAct: z.enum(["QUESTION", "REQUEST", "AUTHORIZATION", "DECLINE", "CORRECTION", "ACKNOWLEDGEMENT", "GOODBYE", "UNKNOWN"]).optional(),
  workflowIntent: z.enum(["NEXT_APPOINTMENT", "CONFIRM_APPOINTMENT", "BOOK_APPOINTMENT", "TRANSFER_TO_STAFF", "OFFICE_INFORMATION", "UNKNOWN"]).optional(),
  requestedAction: z.enum(["LOOKUP_APPOINTMENTS", "CONFIRM_SELECTED_APPOINTMENT", "BOOK_APPOINTMENT", "TRANSFER_TO_STAFF", "NONE"]).optional(),
  patientTypeChoice: z.enum(["NEW_PATIENT", "RETURNING_PATIENT"]).nullable().optional(),
  authorization: z.object({
    stateChangingAction: z.enum(["CONFIRM_APPOINTMENT", "BOOK_APPOINTMENT", "CONTINUE_AS_NEW_PATIENT", "TRANSFER_TO_STAFF"]).nullable().optional(),
    isExplicit: z.boolean().optional(),
    selectedAppointmentReference: z.record(z.unknown()).nullable().optional()
  }).passthrough().optional()
}).passthrough();

const toolRequestSchema = z.union([
  z.object({ name: z.string(), arguments: z.record(z.unknown()) }).passthrough(),
  z.object({}).strict()
]).transform((toolRequest) => Object.keys(toolRequest).length === 0 ? undefined : toolRequest);

const modelTurnResultSchema = z.object({
  reply: z.string().optional(),
  assistantAction: z.enum(["NONE", "OFFER_STAFF_TRANSFER", "END_CALL"]).optional(),
  toolRequest: toolRequestSchema.optional(),
  intent: z.string().optional(),
  callerAction: callerActionSchema.optional(),
  collectedFields: z.record(z.unknown()).optional(),
  updatedFields: z.array(z.string()),
  confirmedFields: z.array(z.string()),
  unclearFields: z.array(z.string()),
  shouldEndCall: z.boolean().optional(),
  confirmationOfferAppointmentId: z.unknown().optional()
}).passthrough();

const modelTurnResponseJsonSchema = {
  type: "object",
  properties: {
    reply: { type: "string" },
    assistantAction: { type: "string", enum: ["NONE", "OFFER_STAFF_TRANSFER", "END_CALL"] },
    toolRequest: {
      anyOf: [
        {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: { type: "object", additionalProperties: true }
          },
          required: ["name", "arguments"],
          additionalProperties: false
        },
        { type: "object", maxProperties: 0, additionalProperties: false }
      ]
    },
    intent: { type: "string" },
    callerAction: {
      type: "object",
      properties: {
        speechAct: { type: "string", enum: ["QUESTION", "REQUEST", "AUTHORIZATION", "DECLINE", "CORRECTION", "ACKNOWLEDGEMENT", "GOODBYE", "UNKNOWN"] },
        workflowIntent: { type: "string", enum: ["NEXT_APPOINTMENT", "CONFIRM_APPOINTMENT", "BOOK_APPOINTMENT", "TRANSFER_TO_STAFF", "OFFICE_INFORMATION", "UNKNOWN"] },
        requestedAction: { type: "string", enum: ["LOOKUP_APPOINTMENTS", "CONFIRM_SELECTED_APPOINTMENT", "BOOK_APPOINTMENT", "TRANSFER_TO_STAFF", "NONE"] },
        patientTypeChoice: { type: "string", enum: ["NEW_PATIENT", "RETURNING_PATIENT"] },
        authorization: {
          type: "object",
          properties: {
            stateChangingAction: { type: "string", enum: ["CONFIRM_APPOINTMENT", "BOOK_APPOINTMENT", "CONTINUE_AS_NEW_PATIENT", "TRANSFER_TO_STAFF"] },
            isExplicit: { type: "boolean" },
            selectedAppointmentReference: { type: "object", additionalProperties: true }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    collectedFields: { type: "object", additionalProperties: true },
    updatedFields: { type: "array", items: { type: "string" } },
    confirmedFields: { type: "array", items: { type: "string" } },
    unclearFields: { type: "array", items: { type: "string" } },
    shouldEndCall: { type: "boolean" },
    confirmationOfferAppointmentId: {}
  },
  required: ["updatedFields", "confirmedFields", "unclearFields"],
  additionalProperties: false
} as const;

type ModelTurnRepairCounts = { responseShape: number; bookingContract: number };

class ModelTurnResponseValidationError extends Error {
  constructor(
    readonly issueDetails: Array<{ field: string; expected: string }>,
    readonly rejectedResponse: unknown
  ) {
    super(issueDetails.map(({ field, expected }) => `${field}: ${expected}`).join("; "));
  }
}

export interface ModelTurnResult {
  reply?: string;
  assistantAction?: "NONE" | "OFFER_STAFF_TRANSFER" | "END_CALL";
  toolRequest?: ToolRequest;
  intent?: string;
  callerAction?: CallerActionDecision;
  collectedFields?: Record<string, unknown>;
  updatedFields?: string[];
  confirmedFields?: string[];
  unclearFields?: string[];
  shouldEndCall?: boolean;
  confirmationOfferAppointmentId?: unknown;
}

export interface ModelCallSummary {
  summaryText: string;
  staffFollowupRequired?: boolean;
  priority?: string;
}

export class ModelClient {
  private readonly client = new OpenAI({
    apiKey: config.OPENAI_API_KEY
  });

  async nextTurn(session: CallSession, callerText: string): Promise<ModelTurnResult> {
    return this.createModelTurn(session, {
      callerText,
      currentIntent: session.currentIntent,
      workflowState: session.workflowState,
      conversationHistory: session.transcript.slice(-12),
      lastAssistantReply: this.findLastAssistantReply(session),
      collectedFields: session.collectedFields,
      lastToolResults: session.lastToolResults,
      pendingActions: session.pendingActions,
      appointmentSelections: session.appointmentSelections,
      newPatientDataConfirmation: newPatientDataConfirmationContext(session)
    });
  }

  async continueWithToolResult(session: CallSession, toolResult: unknown): Promise<ModelTurnResult> {
    return this.createModelTurn(session, {
      instruction: "Use this tool result to produce the next caller-facing response.",
      currentIntent: session.currentIntent,
      workflowState: session.workflowState,
      toolResult,
      conversationHistory: session.transcript.slice(-12),
      lastAssistantReply: this.findLastAssistantReply(session),
      lastCallerReply: this.findLastCallerReply(session),
      collectedFields: session.collectedFields,
      pendingActions: session.pendingActions,
      appointmentSelections: session.appointmentSelections,
      newPatientDataConfirmation: newPatientDataConfirmationContext(session)
    });
  }

  async continueWithPolicyInstruction(
    session: CallSession,
    instruction: string,
    boundaryContext?: ToolPolicyBoundaryContext
  ): Promise<ModelTurnResult> {
    return this.createModelTurn(session, {
      instruction,
      boundaryContext,
      currentIntent: session.currentIntent,
      workflowState: session.workflowState,
      conversationHistory: session.transcript.slice(-12),
      lastAssistantReply: this.findLastAssistantReply(session),
      lastCallerReply: this.findLastCallerReply(session),
      collectedFields: session.collectedFields,
      pendingActions: session.pendingActions,
      appointmentSelections: session.appointmentSelections,
      newPatientDataConfirmation: newPatientDataConfirmationContext(session)
    });
  }

  async bookingResponse(session: CallSession, purpose: BookingResponsePurpose): Promise<ModelTurnResult> {
    const content = await this.requestModelContent(session, {
      instruction: bookingResponseInstruction,
      responseContext: bookingResponseContext(session, purpose),
      conversationHistory: session.transcript.slice(-12)
    });
    let reply: unknown;
    try {
      reply = JSON.parse(content).reply;
    } catch {
      throw new BookingWorkflowError("Invalid booking response JSON");
    }
    if (typeof reply !== "string" || !reply.trim()) {
      throw new BookingWorkflowError("Missing booking response");
    }
    // Wording is model-owned; this response-only call cannot change execution state.
    return { reply, intent: purpose === "HANDOFF" ? "TRANSFER_TO_STAFF" : "BOOK_APPOINTMENT", shouldEndCall: purpose === "HANDOFF" };
  }

  async selectBookingAppointmentType(session: CallSession, candidateReason?: unknown): Promise<number | undefined> {
    const appointmentTypes = eligibleAppointmentTypes(session);
    const reason = bookingReason(session, candidateReason);
    if (!appointmentTypes.length || !reason) {
      return undefined;
    }

    const ids = appointmentTypes.map((type) => type.appointmentTypeId);
    try {
      const response = await this.client.chat.completions.create({
        model: config.OPENAI_MODEL,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "appointment_type_selection",
            strict: true,
            schema: {
              type: "object",
              properties: {
                appointmentTypeId: {
                  type: "integer",
                  enum: ids
                }
              },
              required: ["appointmentTypeId"],
              additionalProperties: false
            }
          }
        },
        messages: [
          {
            role: "system",
            content: [
              "Select the single best appointment type for a dental booking.",
              "Use only the eligible catalog in the user message and match the caller's reason semantically against type and description.",
              "Return only the numeric appointmentTypeId. Never return a name, explanation, or ID outside the catalog.",
              "This is an internal selection step; do not ask the caller to choose an appointment type."
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              patientType: bookingPatientType(session),
              bookingReason: reason,
              eligibleAppointmentTypes: appointmentTypes.map((type) => ({
                appointmentTypeId: type.appointmentTypeId,
                type: type.type,
                description: type.description,
                duration: type.duration
              }))
            })
          }
        ]
      }, {
        timeout: config.AI_MODEL_TIMEOUT_MS
      });

      const content = response.choices[0]?.message?.content ?? "{}";
      const appointmentTypeId = (JSON.parse(content) as { appointmentTypeId?: unknown }).appointmentTypeId;
      if (isEligibleAppointmentTypeId(session, appointmentTypeId)) {
        logger.info("Appointment type selected from eligible catalog", {
          callSid: session.callSid,
          officeCode: session.officeCode,
          patientType: bookingPatientType(session),
          appointmentTypeId,
          catalogSize: appointmentTypes.length
        });
        return appointmentTypeId;
      }

      logger.warn("Model returned an ineligible appointment type selection", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        patientType: bookingPatientType(session),
        appointmentTypeId,
        catalogSize: appointmentTypes.length
      });
    } catch (error) {
      logger.warn("Unable to select appointment type from eligible catalog", {
        callSid: session.callSid,
        officeCode: session.officeCode,
        patientType: bookingPatientType(session),
        catalogSize: appointmentTypes.length,
        error: String(error)
      });
    }

    return undefined;
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
            "The JSON shape is: {\"summaryText\": string, \"staffFollowupRequired\": boolean, \"priority\": \"LOW\"|\"NORMAL\"|\"HIGH\"}.",
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
            workflowState: session.workflowState,
            collectedFields: session.collectedFields,
            lastToolResults: session.lastToolResults,
            pendingActions: session.pendingActions,
            appointmentSelections: session.appointmentSelections,
            transcript: session.transcript
          })
        }
      ]
    }, {
      timeout: config.AI_MODEL_TIMEOUT_MS
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    return this.parseCallSummary(content, session);
  }

  private parseModelResult(content: string): ModelTurnResult {
    let response: unknown;
    try {
      response = JSON.parse(content) as unknown;
    } catch {
      throw new ModelTurnResponseValidationError(
        [{ field: "$", expected: "valid JSON matching the model-turn response schema" }],
        content
      );
    }

    const parsed = modelTurnResultSchema.safeParse(response);
    if (!parsed.success) {
      throw new ModelTurnResponseValidationError(
        parsed.error.issues.map((issue) => ({
          field: issue.path.length ? issue.path.join(".") : "$",
          expected: issue.message
        })),
        response
      );
    }

    const result = parsed.data as ModelTurnResult;
    if (result.toolRequest && !result.toolRequest.name.trim()) {
      delete result.toolRequest;
    }
    return result;
  }

  private async requestModelContent(session: CallSession, payload: Record<string, unknown>): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "voice_ai_model_turn",
          strict: false,
          schema: modelTurnResponseJsonSchema
        }
      },
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(session)
        },
        {
          role: "user",
          content: JSON.stringify(payload)
        }
      ]
    }, {
      timeout: config.AI_MODEL_TIMEOUT_MS
    });

    return response.choices[0]?.message?.content ?? "{}";
  }

  private async createModelTurn(
    session: CallSession,
    payload: Record<string, unknown>,
    repairCounts: ModelTurnRepairCounts = { responseShape: 0, bookingContract: 0 }
  ): Promise<ModelTurnResult> {
    const content = await this.requestModelContent(session, payload);
    let result: ModelTurnResult;
    try {
      result = this.parseModelResult(content);
    } catch (error) {
      if (!(error instanceof ModelTurnResponseValidationError)) throw error;
      logger.warn("Model response failed schema validation", {
        callSid: session.callSid,
        repairAttempt: repairCounts.responseShape,
        issues: error.issueDetails,
        ...(config.NODE_ENV !== "production" && config.AI_LOG_RAW_MODEL_RESPONSES
          ? { rawModelResponse: error.rejectedResponse }
          : {})
      });
      if (repairCounts.responseShape >= 1) {
        throw new BookingWorkflowError(`Model response remained invalid after correction: ${error.message}`);
      }
      const validationError = error.issueDetails
        .map((issue) => `${issue.field}: ${issue.expected}`)
        .join("; ");
      return this.createModelTurn(session, {
        ...payload,
        rejectedModelResult: error.rejectedResponse,
        validationError,
        instruction: [
          "Your previous response did not satisfy the required model-turn response schema.",
          `Correct these field errors: ${validationError}.`,
          "updatedFields, confirmedFields, and unclearFields must each be arrays of strings; use an empty array when there are no values.",
          "Return a complete corrected response, preserve valid caller-provided information, and do not ask the caller to repeat it merely to fix response formatting."
        ].join(" ")
      }, { ...repairCounts, responseShape: repairCounts.responseShape + 1 });
    }
    const contractError = bookingModelContractError(session, result);
    if (!contractError) return result;

    if (contractError.includes("appointmentTypeId") && result.toolRequest?.name === "BOOK_APPOINTMENT") {
      const appointmentTypeId = await this.selectBookingAppointmentType(
        session,
        result.toolRequest.arguments.bookingReason ?? result.collectedFields?.bookingReason
      );
      if (appointmentTypeId !== undefined) {
        return {
          ...result,
          collectedFields: {
            ...result.collectedFields,
            appointmentTypeId
          },
          toolRequest: {
            ...result.toolRequest,
            arguments: {
              ...result.toolRequest.arguments,
              appointmentTypeId
            }
          }
        };
      }
    }

    logger.warn("Booking model contract rejected", {
      callSid: session.callSid,
      repairAttempt: repairCounts.bookingContract,
      argumentFields: Object.keys(result.toolRequest?.arguments ?? {}),
      collectedFieldNames: Object.keys(result.collectedFields ?? {})
    });
    if (repairCounts.bookingContract === 0) {
      const repairInstruction = contractError.includes("appointmentTypeId")
        ? "Your previous BOOK_APPOINTMENT omitted the required appointmentTypeId. Correct the JSON now: use workflowState.context.patientType, select the closest matching numeric ID from the corresponding appointmentTypes catalog using bookingReason and its description, preserve all known fields, and submit BOOK_APPOINTMENT. Do not ask the caller for the ID and do not omit it again."
        : "Correct your previous JSON using the tool contract and known conversation context. Recover known values without asking the caller to repeat them. If information is genuinely missing or ambiguous, ask naturally instead of requesting a tool.";
      return this.createModelTurn(session, {
        ...payload,
        rejectedModelResult: result,
        validationError: contractError,
        instruction: repairInstruction
      }, { ...repairCounts, bookingContract: repairCounts.bookingContract + 1 });
    }
    throw new BookingWorkflowError("Booking model contract remained invalid after correction");
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
        staffFollowupRequired: parsed.staffFollowupRequired ?? false,
        priority: parsed.priority ?? "NORMAL"
      };
    } catch {
      const summaryText = "AI receptionist call completed. Staff can review the transcript for details.";
      return {
        summaryText,
        staffFollowupRequired: true,
        priority: "NORMAL"
      };
    }
  }
}
