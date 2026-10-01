import assert from "node:assert/strict";
import test from "node:test";
import { bookingPatientChoiceFromModel } from "../../src/workflows/bookAppointment/bookingPatientChoice.js";

test("accepts only a structured new-or-returning classification from the model", () => {
  assert.equal(bookingPatientChoiceFromModel({ callerAction: { patientTypeChoice: "NEW_PATIENT" } }), "NEW_PATIENT");
  assert.equal(bookingPatientChoiceFromModel({ callerAction: { patientTypeChoice: "RETURNING_PATIENT" } }), "RETURNING_PATIENT");
  assert.equal(bookingPatientChoiceFromModel({ callerAction: { patientTypeChoice: null } }), undefined);
  assert.equal(bookingPatientChoiceFromModel({ callerAction: { speechAct: "ACKNOWLEDGEMENT" } }), undefined);
  assert.equal(bookingPatientChoiceFromModel({}), undefined);
  assert.equal(bookingPatientChoiceFromModel({ callerAction: { patientTypeChoice: "MAYBE" } } as never), undefined);
});
