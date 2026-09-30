import assert from "node:assert/strict";
import test from "node:test";
import { bookingPatientChoiceFromSpeech } from "../../src/workflows/bookAppointment/bookingPatientChoice.js";

test("takes an explicit new or returning choice, not an ambiguous yes", () => {
  assert.equal(bookingPatientChoiceFromSpeech("I'm a new patient"), "NEW_PATIENT");
  assert.equal(bookingPatientChoiceFromSpeech("This is my first visit"), "NEW_PATIENT");
  assert.equal(bookingPatientChoiceFromSpeech("I'm a returning patient"), "RETURNING_PATIENT");
  assert.equal(bookingPatientChoiceFromSpeech("I'm not a new patient"), "RETURNING_PATIENT");
  assert.equal(bookingPatientChoiceFromSpeech("Yes"), undefined);
});
