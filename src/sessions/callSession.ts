export type Speaker = "patient" | "assistant" | "system" | "tool";

export interface TranscriptTurn {
  speaker: Speaker;
  text: string;
  at: string;
  metadata?: Record<string, unknown>;
}

export interface OfficeContext {
  officeCode: string;
  officeName?: string;
  phoneNumber?: string;
  timezone: string;
  aiMode?: string;
  aiGreeting?: string;
  businessHoursSummary?: string;
  supportedIntents?: string[];
  allowedActions?: string[];
  handoffPolicy?: string;
  emergencyMessage?: string;
  facts?: string[];
}

export interface CallSession {
  callSid: string;
  accountSid?: string;
  officeCode: string;
  fromNumber?: string;
  toNumber?: string;
  startedAt: string;
  lastActivityAt: string;
  officeContext?: OfficeContext;
  patientVerified: boolean;
  currentIntent?: string;
  transcript: TranscriptTurn[];
  collectedFields: Record<string, unknown>;
  lastToolResults: Record<string, unknown>;
}

export class CallSessionStore {
  private readonly sessions = new Map<string, CallSession>();

  get(callSid: string): CallSession | undefined {
    return this.sessions.get(callSid);
  }

  create(input: {
    callSid: string;
    accountSid?: string;
    officeCode: string;
    fromNumber?: string;
    toNumber?: string;
  }): CallSession {
    const now = new Date().toISOString();
    const session: CallSession = {
      callSid: input.callSid,
      accountSid: input.accountSid,
      officeCode: input.officeCode,
      fromNumber: input.fromNumber,
      toNumber: input.toNumber,
      startedAt: now,
      lastActivityAt: now,
      patientVerified: false,
      transcript: [],
      collectedFields: {},
      lastToolResults: {}
    };
    this.sessions.set(input.callSid, session);
    return session;
  }

  touch(session: CallSession): void {
    session.lastActivityAt = new Date().toISOString();
  }

  append(session: CallSession, turn: Omit<TranscriptTurn, "at">): void {
    session.transcript.push({
      ...turn,
      at: new Date().toISOString()
    });
    this.touch(session);
  }

  delete(callSid: string): void {
    this.sessions.delete(callSid);
  }
}
