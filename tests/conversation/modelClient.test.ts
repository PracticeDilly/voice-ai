import assert from "node:assert/strict";
import test from "node:test";
import { CallSessionStore } from "../../src/calls/callSession.js";
import { ModelClient } from "../../src/conversation/modelClient.js";

const validResponse = {
  reply: "What is your first name?",
  updatedFields: ["firstName"],
  confirmedFields: [],
  unclearFields: []
};

function modelClientWithResponses(responses: unknown[]) {
  const modelClient = new ModelClient();
  const requests: Array<Record<string, unknown>> = [];
  Object.defineProperty(modelClient, "client", {
    value: {
      chat: {
        completions: {
          async create(request: Record<string, unknown>) {
            requests.push(request);
            const content = responses.shift();
            return { choices: [{ message: { content: JSON.stringify(content) } }] };
          }
        }
      }
    }
  });
  return { modelClient, requests };
}

function testSession() {
  return new CallSessionStore().create({
    callSid: "CA-model-response-schema",
    officeCode: "TEST"
  });
}

test("accepts correctly typed model field lists and requests their response schema", async () => {
  const { modelClient, requests } = modelClientWithResponses([validResponse]);

  const result = await modelClient.nextTurn(testSession(), "My name is Daniel.");

  assert.deepEqual(result.updatedFields, ["firstName"]);
  assert.deepEqual(result.confirmedFields, []);
  assert.deepEqual(result.unclearFields, []);
  const responseFormat = requests[0].response_format as {
    type: string;
    json_schema: { schema: { properties: Record<string, { type?: string; items?: { type?: string } }> } };
  };
  assert.equal(responseFormat.type, "json_schema");
  for (const field of ["updatedFields", "confirmedFields", "unclearFields"]) {
    assert.equal(responseFormat.json_schema.schema.properties[field].type, "array");
    assert.equal(responseFormat.json_schema.schema.properties[field].items?.type, "string");
  }
});

test("asks the model to correct an object-shaped updatedFields value", async () => {
  const { modelClient, requests } = modelClientWithResponses([
    { ...validResponse, updatedFields: { firstName: true } },
    validResponse
  ]);

  const result = await modelClient.nextTurn(testSession(), "My name is Daniel.");

  assert.deepEqual(result.updatedFields, ["firstName"]);
  assert.equal(requests.length, 2);
  const correctionPayload = JSON.parse(
    (requests[1].messages as Array<{ content: string }>)[1].content
  ) as { validationError: string; rejectedModelResult: { updatedFields: unknown }; instruction: string };
  assert.match(correctionPayload.validationError, /updatedFields.*array/i);
  assert.deepEqual(correctionPayload.rejectedModelResult.updatedFields, { firstName: true });
  assert.match(correctionPayload.instruction, /arrays of strings/i);
});

test("fails explicitly when the corrected model response still violates the schema", async () => {
  const invalidResponse = { ...validResponse, updatedFields: { firstName: true } };
  const { modelClient, requests } = modelClientWithResponses([invalidResponse, invalidResponse]);

  await assert.rejects(
    modelClient.nextTurn(testSession(), "My name is Daniel."),
    /remained invalid after correction.*updatedFields/i
  );
  assert.equal(requests.length, 2);
});
