import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { WebSocket } from "ws";

test("arms no-input reprompt after externally provided welcome greeting", async () => {
  const { CallSessionStore } = await import("../../src/calls/callSession.js");
  const { ConversationRelayHandler } = await import("../../src/twilio/conversationRelayHandler.js");
  const ws = new FakeWebSocket();
  const handler = new ConversationRelayHandler();
  const sessions = new CallSessionStore();
  const session = sessions.create({
    callSid: "CA-no-input-after-external-greeting",
    officeCode: "MSHNN"
  });
  session.officeContext = {
    officeCode: "MSHNN",
    aiGreeting: "Hi, this is Lisa. How can I help?"
  };
  const recordedTurns: string[] = [];
  const armedTimers: Array<{ assistantText: string; noInputCount: number }> = [];

  (handler as unknown as {
    sessions: CallSessionStore;
    orchestrator: {
      initializeSession(): Promise<typeof session>;
      recordAssistantTurn(session: typeof session, text: string): Promise<void>;
      completeSession(): Promise<void>;
    };
    resetNoInputTimer(
      session: typeof session,
      ws: WebSocket,
      assistantText: string,
      existingTimer: ReturnType<typeof setTimeout> | undefined,
      noInputCount: number,
      setNoInputCount: (value: number) => void,
      setNoInputTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void
    ): ReturnType<typeof setTimeout>;
  }).sessions = sessions;

  (handler as unknown as {
    orchestrator: {
      initializeSession(): Promise<typeof session>;
      recordAssistantTurn(session: typeof session, text: string): Promise<void>;
      completeSession(): Promise<void>;
    };
  }).orchestrator = {
    async initializeSession() {
      return session;
    },
    async recordAssistantTurn(_session, text) {
      recordedTurns.push(text);
    },
    async completeSession() {}
  };

  (handler as unknown as {
    resetNoInputTimer(
      session: typeof session,
      ws: WebSocket,
      assistantText: string,
      existingTimer: ReturnType<typeof setTimeout> | undefined,
      noInputCount: number,
      setNoInputCount: (value: number) => void,
      setNoInputTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void
    ): ReturnType<typeof setTimeout>;
  }).resetNoInputTimer = (_session, _ws, assistantText, _existingTimer, noInputCount) => {
    armedTimers.push({ assistantText, noInputCount });
    return undefined as unknown as ReturnType<typeof setTimeout>;
  };

  void handler.handleConnection(ws as unknown as WebSocket);

  ws.emit("message", JSON.stringify({
    type: "setup",
    callSid: session.callSid,
    customParameters: {
      officeCode: session.officeCode,
      welcomeGreetingProvided: "true"
    }
  }));

  await setImmediate();

  assert.deepEqual(ws.sentMessages, []);
  assert.deepEqual(recordedTurns, []);
  assert.equal(armedTimers.length, 1);
  assert.equal(armedTimers[0]?.assistantText, "Hi, this is Lisa. How can I help?");
  assert.equal(armedTimers[0]?.noInputCount, 0);
});

class FakeWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sentMessages: unknown[] = [];

  send(payload: string): void {
    this.sentMessages.push(JSON.parse(payload));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}
