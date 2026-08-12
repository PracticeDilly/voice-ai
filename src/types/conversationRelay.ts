export type ConversationRelayMessage =
  | ConversationRelaySetupMessage
  | ConversationRelayPromptMessage
  | ConversationRelayInterruptMessage
  | ConversationRelayDtmfMessage
  | ConversationRelayErrorMessage
  | ConversationRelayUnknownMessage;

export interface ConversationRelaySetupMessage {
  type: "setup";
  callSid?: string;
  accountSid?: string;
  from?: string;
  to?: string;
  customParameters?: Record<string, string>;
  [key: string]: unknown;
}

export interface ConversationRelayPromptMessage {
  type: "prompt";
  voicePrompt?: string;
  lang?: string;
  last?: boolean;
  [key: string]: unknown;
}

export interface ConversationRelayInterruptMessage {
  type: "interrupt";
  utteranceUntilInterrupt?: string;
  durationUntilInterruptMs?: number;
  [key: string]: unknown;
}

export interface ConversationRelayDtmfMessage {
  type: "dtmf";
  digit?: string;
  [key: string]: unknown;
}

export interface ConversationRelayErrorMessage {
  type: "error";
  description?: string;
  [key: string]: unknown;
}

export interface ConversationRelayUnknownMessage {
  type: string;
  [key: string]: unknown;
}

export interface ConversationRelayTextResponse {
  type: "text";
  token: string;
  last?: boolean;
  interruptible?: boolean;
  preemptible?: boolean;
}

export interface ConversationRelayPlayResponse {
  type: "play";
  source: string;
  loop?: number;
  preemptible?: boolean;
  interruptible?: boolean;
}

export interface ConversationRelayEndResponse {
  type: "end";
  handoffData?: string;
}

export type ConversationRelayResponse =
  | ConversationRelayTextResponse
  | ConversationRelayPlayResponse
  | ConversationRelayEndResponse;
