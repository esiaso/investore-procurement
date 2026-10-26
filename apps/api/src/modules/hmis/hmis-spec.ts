import { EXT, SIL_SYSTEM } from './fhir';

/**
 * Choices made where FHIR R4 (or a typical HMIS) leaves room. Review them with
 * the HMIS vendor before go-live; also served at GET /hmis/assumptions.
 */
export const HMIS_ASSUMPTIONS: { topic: string; choice: string }[] = [
  { topic: 'Master data', choice: 'The HMIS is the patient register. Patients and encounters are cached with the minimum fields used here and refreshed when older than hmis.patientRefreshHours.' },
  { topic: 'Hospital number', choice: 'Patient.identifier with the connection\'s hospital-number system; else the identifier typed MR; else the first identifier.' },
  { topic: 'Orders', choice: 'MedicationRequest with medicationCodeableConcept (medicationReference is not read). Orders sharing groupIdentifier become one prescription while it is open at the same outlet.' },
  { topic: 'Drug codes', choice: 'Each coding is tried in order: a DRUG mapping (to a generic, or to a brand item), else an item whose code or GTIN equals the code. Unmapped orders fail and can be reprocessed after mapping.' },
  { topic: 'Quantity', choice: 'dispenseRequest.quantity in base units; without it, a countable dose (tab, cap…) × frequency per day × expectedSupplyDuration (days).' },
  { topic: 'Outlet', choice: 'dispenseRequest.performer (identifier value) mapped as a LOCATION; else hmis.defaultOutlets by encounter class (AMB → OPD, IMP/ACUTE → IPD, EMER → EMERGENCY, SS → DAY_CASE).' },
  { topic: 'Changes and stops', choice: 'A new version of an active order already received is logged and ignored (changes are not applied after receipt). Status stopped / cancelled / entered-in-error / completed cancels the undispensed balance.' },
  { topic: 'Inpatient supply', choice: `Extension ${EXT.supplyMode} (DAILY | UNIT_DOSE) marks ward supply; the daily quantity is ${EXT.dailyQuantity} or dose × frequency. The ward round dispenses what is due today.` },
  { topic: 'Payer', choice: `Extension ${EXT.payer} (valueCoding.code, mapped as PAYER) and ${EXT.memberNo} on Patient (default) and Encounter (this visit). No payer = cash.` },
  { topic: 'Weight and pregnancy', choice: `Extensions ${EXT.weightKg} and ${EXT.pregnant} on Patient (Observations are not read).` },
  { topic: 'Dispense records', choice: `One MedicationDispense per batch given (identifier ${SIL_SYSTEM.dispense}), with a contained Medication carrying the batch and expiry, authorizingPrescription and context. After a return it is updated (PUT) with the net quantity and a note.` },
  { topic: 'Charges', choice: `Billing mode HMIS: one ChargeItem per batch line (identifier ${SIL_SYSTEM.charge}), priceOverride = VAT-inclusive price from the payer's price list × quantity. A return is a ChargeItem with a negative quantity and partOf the original. The HMIS issues the patient's tax invoice (eTIMS) for its bill.` },
  { topic: 'No double charging', choice: 'Each dispense batch line, issue line and consumption line is charged once (unique key). With billing mode HMIS no local invoice is raised for HMIS encounters; with LOCAL the invoice here is the charge and nothing is posted to the HMIS bill.' },
  { topic: 'Idempotency', choice: 'Inbound: one message per resource version (meta.versionId, else a hash of the content); repeats are counted and ignored. Outbound: conditional create by identifier, so a re-sent record is not duplicated by an HMIS that honours it (the mock does).' },
  { topic: 'Retries', choice: 'Network errors, timeouts, HTTP 5xx, 408 and 429 are retried with back-off (hmis.retryBaseSeconds × 2ⁿ, capped at 1 h, up to hmis.maxAttempts); other 4xx fail at once and are listed on the integration dashboard.' },
  { topic: 'Generic REST', choice: 'Same neutral records as JSON: GET /patients?q=, /patients/:id, /encounters/:id, /orders?since=; POST /dispenses, PUT /dispenses/:id, POST /charges. Webhook: POST /integration/hmis/events {type: patient|encounter|allergy|order, data}.' },
  { topic: 'HL7 v2', choice: 'Not implemented. An HL7 v2 feed (ADT, RDE/RDS) can be added as another HmisAdapter / inbound parser producing the same neutral records.' },
];
