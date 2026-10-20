import { InteractionSeverity, PriceListType } from '@sil/shared';

/**
 * Billing and eTIMS defaults. Data, not code: inserted when missing and then
 * maintained through the API (Billing → Price lists / Payment modes, eTIMS →
 * Mappings).
 */
export const DEFAULT_PRICE_LISTS: { code: string; name: string; type: PriceListType; adjustPercent: number; isDefault: boolean }[] = [
  { code: 'RETAIL', name: 'Retail (walk-in / cash)', type: PriceListType.RETAIL, adjustPercent: 0, isDefault: true },
  { code: 'STAFF', name: 'Staff', type: PriceListType.STAFF, adjustPercent: -10, isDefault: false },
  { code: 'CORPORATE', name: 'Corporate schemes', type: PriceListType.CORPORATE, adjustPercent: 0, isDefault: false },
  { code: 'INSURANCE', name: 'Insurance', type: PriceListType.INSURANCE, adjustPercent: 0, isDefault: false },
];

/** Payment modes and their eTIMS payment type (code class 07). */
export const DEFAULT_PAYMENT_MODES: { code: string; name: string; etimsPaymentTypeCode: string; requiresReference: boolean; isCredit: boolean }[] = [
  { code: 'CASH', name: 'Cash', etimsPaymentTypeCode: '01', requiresReference: false, isCredit: false },
  { code: 'MPESA', name: 'M-Pesa', etimsPaymentTypeCode: '06', requiresReference: true, isCredit: false },
  { code: 'CARD', name: 'Debit / credit card', etimsPaymentTypeCode: '05', requiresReference: false, isCredit: false },
  { code: 'INSURANCE', name: 'Insurance', etimsPaymentTypeCode: '02', requiresReference: false, isCredit: true },
  { code: 'CORPORATE', name: 'Corporate', etimsPaymentTypeCode: '02', requiresReference: false, isCredit: true },
  { code: 'CREDIT', name: 'On account (credit)', etimsPaymentTypeCode: '02', requiresReference: false, isCredit: true },
];

/**
 * Local code → eTIMS code. Tax types follow the VAT Act categories
 * (A exempt, B 16%, C zero-rated); unit codes are from the OSCU/VSCU code
 * tables (class 10 quantity unit, class 17 packaging unit). Item classes are
 * mapped per installation once the classification is synced.
 */
export const DEFAULT_ETIMS_MAPPINGS: [kind: string, localKey: string, etimsCode: string][] = [
  ['TAX_CATEGORY', 'EXEMPT', 'A'],
  ['TAX_CATEGORY', 'STANDARD', 'B'],
  ['TAX_CATEGORY', 'ZERO', 'C'],
  ...(['TAB', 'CAP', 'STRIP', 'PCS', 'AMP', 'VIAL', 'SACHET', 'PESS', 'INH', 'KIT', 'BTL', 'BAG'] as const).map((u) => ['QTY_UNIT', u, 'U'] as [string, string, string]),
  ['QTY_UNIT', 'BOX', 'BX'],
  ['QTY_UNIT', 'TUBE', 'TU'],
  ['QTY_UNIT', 'PAIR', '4B'],
  ['QTY_UNIT', 'PACK', 'PA'],
  ['QTY_UNIT', 'ROLL', 'RO'],
  ['QTY_UNIT', 'L', 'L'],
  ['PACKAGING_UNIT', 'AMP', 'AM'],
  ['PACKAGING_UNIT', 'BAG', 'BG'],
  ['PACKAGING_UNIT', 'BOX', 'CT'],
  ['PACKAGING_UNIT', 'ROLL', 'RO'],
];

/**
 * DEMONSTRATION interaction pairs (source DEMO) so the checks can be seen
 * working. They are illustrative only and NOT a clinical reference: replace
 * or extend them from a licensed source via CSV import before go-live.
 * Keys are lower-case INNs, or "class:<therapeutic class>".
 */
export const DEMO_INTERACTIONS: [a: string, b: string, severity: InteractionSeverity, mechanism: string, management: string][] = [
  ['heparin sodium', 'class:nsaid', InteractionSeverity.MAJOR, 'Additive bleeding risk (anticoagulant + NSAID)', 'Avoid; use paracetamol for analgesia or monitor closely for bleeding'],
  ['enoxaparin sodium', 'class:nsaid', InteractionSeverity.MAJOR, 'Additive bleeding risk (anticoagulant + NSAID)', 'Avoid; use paracetamol for analgesia or monitor closely for bleeding'],
  ['class:benzodiazepine', 'class:opioid analgesic', InteractionSeverity.MAJOR, 'Additive CNS and respiratory depression', 'Use lowest doses, monitor sedation and respiration'],
  ['aminophylline', 'ciprofloxacin', InteractionSeverity.MAJOR, 'Ciprofloxacin reduces theophylline clearance (toxicity, seizures)', 'Avoid or reduce aminophylline dose and monitor levels'],
  ['amitriptyline', 'tramadol hydrochloride', InteractionSeverity.MAJOR, 'Serotonin syndrome and lowered seizure threshold', 'Avoid combination or monitor closely'],
  ['enalapril', 'potassium chloride', InteractionSeverity.MAJOR, 'Hyperkalaemia', 'Monitor serum potassium; avoid routine supplementation'],
  ['losartan potassium', 'potassium chloride', InteractionSeverity.MAJOR, 'Hyperkalaemia', 'Monitor serum potassium; avoid routine supplementation'],
  ['enalapril', 'losartan potassium', InteractionSeverity.MAJOR, 'Dual RAAS blockade: hyperkalaemia, hypotension, renal impairment', 'Avoid combination'],
  ['furosemide', 'gentamicin', InteractionSeverity.MAJOR, 'Additive ototoxicity and nephrotoxicity', 'Avoid or monitor renal function and hearing'],
  ['class:ace inhibitor', 'class:nsaid', InteractionSeverity.MODERATE, 'NSAIDs reduce the antihypertensive effect and may impair renal function', 'Monitor blood pressure and renal function'],
  ['acetylsalicylic acid', 'ibuprofen', InteractionSeverity.MODERATE, 'Ibuprofen may blunt the antiplatelet effect of low-dose aspirin', 'Give aspirin at least 30 minutes before ibuprofen'],
  ['ciprofloxacin', 'glibenclamide', InteractionSeverity.MODERATE, 'Dysglycaemia (hypo- or hyperglycaemia)', 'Monitor blood glucose'],
  ['ferrous sulfate', 'levothyroxine sodium', InteractionSeverity.MODERATE, 'Iron reduces levothyroxine absorption', 'Separate doses by at least 4 hours'],
  ['carbamazepine', 'doxycycline', InteractionSeverity.MODERATE, 'Carbamazepine induces doxycycline metabolism', 'Consider an alternative antibiotic or monitor response'],
  ['azithromycin', 'ondansetron', InteractionSeverity.MODERATE, 'Additive QT prolongation', 'Check ECG risk factors; monitor'],
  ['cetirizine', 'chlorphenamine maleate', InteractionSeverity.MINOR, 'Additive antihistamine effects (sedation)', 'Usually avoid two antihistamines'],
];

/** DEMONSTRATION dispensing flags on sample generics (pregnancy / minimum age). Verify before go-live. */
export const DEMO_GENERIC_FLAGS: { inn: string; pregnancyContraindicated?: boolean; minAgeYears?: number }[] = [
  { inn: 'Doxycycline', pregnancyContraindicated: true, minAgeYears: 8 },
  { inn: 'Tetracycline', pregnancyContraindicated: true, minAgeYears: 8 },
  { inn: 'Atorvastatin', pregnancyContraindicated: true },
  { inn: 'Enalapril', pregnancyContraindicated: true },
  { inn: 'Losartan potassium', pregnancyContraindicated: true },
  { inn: 'Ciprofloxacin', minAgeYears: 18 },
  { inn: 'Tramadol hydrochloride', minAgeYears: 12 },
  { inn: 'Acetylsalicylic acid', minAgeYears: 16 },
];
