import { config } from "../config/env.js";
import { OfficeContext } from "../sessions/callSession.js";

export interface ToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export class SpringBootClient {
  async getOfficeContext(officeCode: string, callSid: string): Promise<OfficeContext> {
    return this.request<OfficeContext>(`/voice/ai/offices/${encodeURIComponent(officeCode)}/context?callSid=${encodeURIComponent(callSid)}`);
  }

  async executeTool(callSid: string, officeCode: string, tool: ToolRequest): Promise<ToolResult> {
    return this.request<ToolResult>("/voice/ai/tools/execute", {
      method: "POST",
      body: JSON.stringify({
        callSid,
        officeCode,
        toolName: tool.name,
        arguments: tool.arguments
      })
    });
  }

  async saveTranscriptTurn(input: {
    callSid: string;
    officeCode: string;
    speaker: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.request<void>("/voice/ai/transcript/turns", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async completeCall(input: {
    callSid: string;
    officeCode: string;
    transcript: unknown[];
    collectedFields: Record<string, unknown>;
    lastToolResults: Record<string, unknown>;
  }): Promise<void> {
    await this.request<void>("/voice/ai/calls/complete", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, config.SPRING_BOOT_BASE_URL), {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.SPRING_BOOT_SERVICE_TOKEN}`,
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Spring Boot API failed ${response.status}: ${body}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}
