# DocProxy Voice AI Node Service

Node.js WebSocket service for the AI receptionist using Twilio Conversation Relay.

## Purpose

This application owns the live AI call session:

- Receives Twilio Conversation Relay WebSocket messages.
- Maintains per-call session state by `callSid`.
- Calls the AI model with office context and conversation history.
- Maps model tool requests to approved Spring Boot APIs.
- Sends response text back to Twilio for speech.
- Saves transcript, summary, and action outcomes through Spring Boot.

The AI model does not call Spring Boot, DocClient, Twilio, or the database directly. Node.js is the orchestrator.

## Project Structure

```text
src/
  appointments/  Next-appointment and confirmation workflows
  backend/       Spring Boot API client and contracts
  calls/         Per-call session state
  conversation/  Model interaction and conversation orchestration
  tools/         Approved tool execution
  twilio/        Conversation Relay transport and message types
  workflows/     Backend workflow contract parsing
  config/        Environment configuration
  utils/         Shared infrastructure helpers
```

Business actions are validated before tool execution. Conversation code coordinates model turns, while Spring Boot remains authoritative for workflow state and business mutations.

## Local Setup

```bash
cd voice-ai-node
npm install
copy .env.example .env
npm run dev
```

Health check:

```text
GET http://localhost:8081/health
```

Conversation Relay WebSocket:

```text
ws://localhost:8081/ai/conversation
```

Production TwiML should use `wss://`:

```xml
<Response>
  <Connect>
    <ConversationRelay url="wss://voiceapitest.practicedilly.com/ai/conversation">
      <Parameter name="officeId" value="123" />
      <Parameter name="callSid" value="CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
      <Parameter name="fromNumber" value="+19494846418" />
      <Parameter name="toNumber" value="+19494075907" />
    </ConversationRelay>
  </Connect>
</Response>
```

The Node.js service requires `officeId` and `callSid` in the Conversation Relay setup payload. Spring Boot should create the AI call log first, then return Conversation Relay TwiML with those values.

## Expected Spring Boot AI APIs

The first version expects Spring Boot to expose these internal service endpoints:

```text
GET  /voice/ai/offices/{officeId}/context?callSid=...
POST /voice/ai/tools/execute
POST /voice/ai/transcript/turns
POST /voice/ai/calls/complete
```

These are service-to-service endpoints. They should require a backend service token and should not be called directly by the Electron app or browser.

## AWS ALB Deployment Notes

You can reuse the same Application Load Balancer, but the Node.js service needs its own routing target.

Recommended ALB options:

1. Same ALB, separate target group for Node.js.
   - Spring Boot target group: EC2 port `8080`
   - Node.js target group: EC2 port `8081`
   - Rule: `Host = voiceapitest.practicedilly.com` and `Path = /ai/*` forwards to Node.js target group.
   - Rule: `Host = voiceapitest.practicedilly.com` and `Path = /voice/*` forwards to Spring Boot target group.

2. Same EC2 instance, two processes.
   - Spring Boot listens on `8080`.
   - Node.js listens on `8081`.
   - Register the same EC2 instance in two target groups using the appropriate ports.

ALB supports WebSocket connections. Make sure the target group health check uses:

```text
GET /health
```

## Initial Tool Registry

The first production tool set should stay small:

- `VERIFY_PATIENT`
- `GET_NEXT_APPOINTMENT`
- `CONFIRM_APPOINTMENT`
- `GET_INSURANCE_POLICY`
- `TRANSFER_TO_STAFF`
- `SAVE_CALL_SUMMARY`

Each tool maps to an approved Spring Boot endpoint.

## Production Guardrails

- Keep model responses grounded in Spring Boot/DocClient data.
- Never let the model invent appointment times, appointment availability, insurance coverage, or payment balances.
- Send only minimum necessary patient context to the model.
- Always support staff handoff for emergencies, explicit human requests, low confidence, and sensitive topics.
- Persist transcript events and tool calls for audit.
