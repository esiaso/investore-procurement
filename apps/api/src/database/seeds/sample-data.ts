import { ControlledSchedule, GlAccountType, RoleCodes, SalesClass, ServicePoint, StoreType } from '@sil/shared';

/*
 * Sample data for a fictitious private hospital. Brand and manufacturer names
 * are typical of the Kenyan market; prices, PPB registration numbers and GTINs
 * are made up (GTINs use the GS1 "2" restricted-circulation prefix).
 */

export const SAMPLE_FACILITY = {
  code: 'SIL-NBI',
  name: 'Sample Imani Lifecare Hospital',
  address: 'P.O. Box 00000-00100, Nairobi',
  phone: '+254 700 000000',
  email: 'info@hospital.example',
  kraPin: 'P000000000X',
};

export const SAMPLE_STORES: {
  code: string;
  name: string;
  type: StoreType;
  servicePoint: ServicePoint | null;
  parent: string | null;
  bins: string[];
}[] = [
  { code: 'MS', name: 'Main Store', type: StoreType.MAIN_STORE, servicePoint: null, parent: null, bins: ['A-01', 'A-02', 'A-03', 'B-01', 'B-02', 'COLD-01', 'BULK-01'] },
  { code: 'MP', name: 'Main Pharmacy', type: StoreType.MAIN_PHARMACY, servicePoint: null, parent: 'MS', bins: ['SH-01', 'SH-02', 'SH-03', 'FRIDGE-01', 'CD-SAFE'] },
  { code: 'OPD-PH', name: 'OPD Pharmacy', type: StoreType.SATELLITE_PHARMACY, servicePoint: ServicePoint.OPD, parent: 'MP', bins: ['OPD-01', 'OPD-02', 'OPD-FR'] },
  { code: 'IPD-PH', name: 'IPD Pharmacy', type: StoreType.SATELLITE_PHARMACY, servicePoint: ServicePoint.IPD, parent: 'MP', bins: ['IPD-01', 'IPD-02', 'IPD-CD'] },
  { code: 'TH-PH', name: 'Theatre Pharmacy', type: StoreType.SATELLITE_PHARMACY, servicePoint: ServicePoint.THEATRE, parent: 'MP', bins: ['TH-01', 'TH-CD', 'TH-FR'] },
  { code: 'ER-PH', name: 'Emergency Pharmacy', type: StoreType.SATELLITE_PHARMACY, servicePoint: ServicePoint.EMERGENCY, parent: 'MP', bins: ['ER-01', 'ER-CRASH'] },
];

export const SAMPLE_DEPARTMENTS: [code: string, name: string, costCentre: string][] = [
  ['OPD', 'Outpatient Department', 'CC-100'],
  ['IPD-MED', 'Medical Ward', 'CC-210'],
  ['IPD-SURG', 'Surgical Ward', 'CC-220'],
  ['MAT', 'Maternity', 'CC-230'],
  ['PAED', 'Paediatrics', 'CC-240'],
  ['ICU', 'Intensive Care Unit', 'CC-250'],
  ['THEATRE', 'Main Theatre', 'CC-300'],
  ['ER', 'Accident & Emergency', 'CC-400'],
  ['LAB', 'Laboratory', 'CC-500'],
  ['RAD', 'Radiology', 'CC-510'],
  ['PHARM', 'Pharmacy', 'CC-600'],
  ['ADMIN', 'Administration', 'CC-900'],
];

/** One login per role; stores = data scope for store-scoped roles. */
export const SAMPLE_USERS: { username: string; fullName: string; role: string; stores: string[]; department?: string }[] = [
  { username: 'admin', fullName: 'System Administrator', role: RoleCodes.SYSTEM_ADMIN, stores: [] },
  { username: 'proc.officer', fullName: 'Achieng Procurement', role: RoleCodes.PROCUREMENT_OFFICER, stores: [], department: 'ADMIN' },
  { username: 'proc.manager', fullName: 'Kamau Approver', role: RoleCodes.PROCUREMENT_MANAGER, stores: [], department: 'ADMIN' },
  { username: 'storekeeper', fullName: 'Wanjiru Stores', role: RoleCodes.STOREKEEPER, stores: ['MS'] },
  { username: 'pharmacist', fullName: 'Otieno Pharmacist', role: RoleCodes.PHARMACIST, stores: ['MP', 'OPD-PH', 'IPD-PH'], department: 'PHARM' },
  { username: 'pharm.tech', fullName: 'Njeri Technician', role: RoleCodes.PHARMACY_TECHNICIAN, stores: ['OPD-PH'], department: 'PHARM' },
  { username: 'cashier', fullName: 'Mutua Cashier', role: RoleCodes.POS_CASHIER, stores: ['OPD-PH'] },
  { username: 'quality', fullName: 'Chebet Quality', role: RoleCodes.QUALITY_OFFICER, stores: [] },
  { username: 'ward.incharge', fullName: 'Akinyi Ward Sister', role: RoleCodes.WARD_IN_CHARGE, stores: [], department: 'IPD-MED' },
  { username: 'ward.nurse', fullName: 'Moraa Nurse', role: RoleCodes.WARD_STAFF, stores: [], department: 'IPD-MED' },
  { username: 'surg.incharge', fullName: 'Kiprop Theatre Sister', role: RoleCodes.WARD_IN_CHARGE, stores: [], department: 'IPD-SURG' },
  { username: 'surg.nurse', fullName: 'Halima Nurse', role: RoleCodes.WARD_STAFF, stores: [], department: 'IPD-SURG' },
  { username: 'mat.incharge', fullName: 'Wairimu Midwife In-charge', role: RoleCodes.WARD_IN_CHARGE, stores: [], department: 'MAT' },
  { username: 'mat.nurse', fullName: 'Nafula Midwife', role: RoleCodes.WARD_STAFF, stores: [], department: 'MAT' },
  { username: 'finance', fullName: 'Mwangi Finance', role: RoleCodes.FINANCE, stores: [], department: 'ADMIN' },
  // A second finance user so invoices can be captured and approved by different people.
  { username: 'accountant', fullName: 'Atieno Accountant', role: RoleCodes.FINANCE, stores: [], department: 'ADMIN' },
  { username: 'finance.manager', fullName: 'Njoroge Finance Manager', role: RoleCodes.FINANCE_MANAGER, stores: [], department: 'ADMIN' },
  { username: 'tender', fullName: 'Hassan Committee', role: RoleCodes.TENDER_COMMITTEE, stores: [] },
  { username: 'scm', fullName: 'Wafula Supply Chain', role: RoleCodes.SUPPLY_CHAIN_MANAGER, stores: [] },
  { username: 'supplier', fullName: 'Sample Supplier Ltd', role: RoleCodes.SUPPLIER, stores: [] },
  { username: 'supplier2', fullName: 'Second Sample Supplier', role: RoleCodes.SUPPLIER, stores: [] },
  { username: 'auditor', fullName: 'Internal Auditor', role: RoleCodes.AUDITOR, stores: [] },
  { username: 'management', fullName: 'Medical Director', role: RoleCodes.HOSPITAL_MANAGEMENT, stores: [] },
];

/** Chart of accounts for non-stock buying (codes as in a typical hospital ledger). */
export const SAMPLE_GL_ACCOUNTS: [code: string, name: string, type: GlAccountType][] = [
  ['5100', 'Repairs and maintenance - buildings', GlAccountType.EXPENSE],
  ['5110', 'Repairs and maintenance - medical equipment', GlAccountType.EXPENSE],
  ['5200', 'Consultancy and professional fees', GlAccountType.EXPENSE],
  ['5210', 'Legal and audit fees', GlAccountType.EXPENSE],
  ['5300', 'Office supplies and stationery', GlAccountType.EXPENSE],
  ['5310', 'Printing and publications', GlAccountType.EXPENSE],
  ['5400', 'Utilities - electricity and water', GlAccountType.EXPENSE],
  ['5410', 'Telephone and internet', GlAccountType.EXPENSE],
  ['5500', 'Cleaning and laundry services', GlAccountType.EXPENSE],
  ['5510', 'Security services', GlAccountType.EXPENSE],
  ['5600', 'Travel and accommodation', GlAccountType.EXPENSE],
  ['5610', 'Staff training and conferences', GlAccountType.EXPENSE],
  ['5700', 'Small equipment expensed (below capitalisation threshold)', GlAccountType.EXPENSE],
  ['5800', 'Bank and M-Pesa charges', GlAccountType.EXPENSE],
  ['1600', 'Furniture and fittings', GlAccountType.ASSET],
  ['1610', 'Computers and IT equipment', GlAccountType.ASSET],
];

export const SAMPLE_PROJECTS: [code: string, name: string, department: string, budget: number | null][] = [
  ['MAT-WING', 'Maternity wing renovation', 'MAT', 5_000_000],
  ['ICU-UPGRADE', 'ICU equipment upgrade', 'ICU', 12_000_000],
  ['EMR-ROLLOUT', 'Electronic records roll-out', 'ADMIN', 3_500_000],
];

/** KES per unit (indicative). */
export const SAMPLE_EXCHANGE_RATES: [currency: string, rate: number][] = [
  ['USD', 129.35],
  ['EUR', 140.2],
  ['GBP', 165.8],
];

export interface SampleGeneric {
  inn: string;
  strength: string;
  form: string;
  route: string;
  atc: string;
  cls: string;
  category: string;
  keml: boolean;
  salesClass: SalesClass;
  uom: string;
  tax?: string;
  schedule?: ControlledSchedule;
  cold?: boolean;
  storage?: string;
  pregnancy?: string;
  lactation?: string;
  /** [brand, manufacturer, pack size, price per base unit (KES)] */
  brands: [string, string, string, number][];
}

const COSMOS = 'Cosmos Ltd';
const DAWA = 'Dawa Ltd';
const UCL = 'Universal Corporation Ltd';
const BETA = 'Beta Healthcare';
const REGAL = 'Regal Pharmaceuticals';
const LAB = 'Laboratory & Allied Ltd';
const ELYS = 'Elys Chemical Industries';
const BELOW25 = 'Store below 25°C, protect from light and moisture';
const COLD = 'Store at 2–8°C. Do not freeze';

const g = (x: SampleGeneric) => x;

export const SAMPLE_GENERICS: SampleGeneric[] = [
  // Analgesics
  g({ inn: 'Paracetamol', strength: '500 mg', form: 'Tablet', route: 'Oral', atc: 'N02BE01', cls: 'Analgesic / antipyretic', category: 'DRUG-ANALG', keml: true, salesClass: SalesClass.OTC, uom: 'TAB', storage: BELOW25, pregnancy: 'Compatible at usual doses', lactation: 'Compatible',
    brands: [['Panadol', 'Haleon', '10x10', 3.5], ['Paracetamol Cosmos', COSMOS, '10x10', 1.0], ['Paracetamol Dawa', DAWA, '10x10', 0.9], ['Paracetamol Elys', ELYS, '100x10', 0.8]] }),
  g({ inn: 'Paracetamol', strength: '120 mg/5 mL', form: 'Suspension', route: 'Oral', atc: 'N02BE01', cls: 'Analgesic / antipyretic', category: 'DRUG-ANALG', keml: true, salesClass: SalesClass.OTC, uom: 'BTL',
    brands: [['Calpol', 'Haleon', '100 mL', 420], ['Paracetamol Syrup Cosmos', COSMOS, '60 mL', 85], ['Paracetamol Syrup Beta', BETA, '100 mL', 110]] }),
  g({ inn: 'Paracetamol', strength: '1 g/100 mL', form: 'Infusion', route: 'Intravenous', atc: 'N02BE01', cls: 'Analgesic / antipyretic', category: 'DRUG-ANALG', keml: true, salesClass: SalesClass.POM, uom: 'BTL',
    brands: [['Perfalgan', 'Bristol-Myers Squibb', '100 mL', 950], ['Paracetamol IV UCL', UCL, '100 mL', 450]] }),
  g({ inn: 'Ibuprofen', strength: '400 mg', form: 'Tablet', route: 'Oral', atc: 'M01AE01', cls: 'NSAID', category: 'DRUG-ANALG', keml: true, salesClass: SalesClass.P, uom: 'TAB', pregnancy: 'Avoid in third trimester',
    brands: [['Brufen', 'Abbott', '10x10', 6.0], ['Ibuprofen Cosmos', COSMOS, '10x10', 1.5], ['Ibuprofen Dawa', DAWA, '10x10', 1.4]] }),
  g({ inn: 'Diclofenac sodium', strength: '50 mg', form: 'Tablet (enteric coated)', route: 'Oral', atc: 'M01AB05', cls: 'NSAID', category: 'DRUG-ANALG', keml: true, salesClass: SalesClass.POM, uom: 'TAB', pregnancy: 'Avoid in third trimester',
    brands: [['Voltaren', 'Novartis', '10x10', 18.0], ['Diclofenac Regal', REGAL, '10x10', 1.8], ['Diclofenac Beta', BETA, '10x10', 1.7]] }),
  g({ inn: 'Diclofenac sodium', strength: '75 mg/3 mL', form: 'Injection', route: 'Intramuscular', atc: 'M01AB05', cls: 'NSAID', category: 'DRUG-ANALG', keml: true, salesClass: SalesClass.POM, uom: 'AMP',
    brands: [['Voltaren Injection', 'Novartis', '5 ampoules', 160], ['Diclofenac Injection UCL', UCL, '10 ampoules', 35]] }),
  g({ inn: 'Tramadol hydrochloride', strength: '50 mg', form: 'Capsule', route: 'Oral', atc: 'N02AX02', cls: 'Opioid analgesic', category: 'DRUG-ANALG', keml: true, salesClass: SalesClass.POM, uom: 'CAP',
    brands: [['Tramal', 'Grünenthal', '10x10', 22.0], ['Tramadol Cosmos', COSMOS, '10x10', 4.5]] }),
  g({ inn: 'Morphine sulfate', strength: '10 mg/mL', form: 'Injection', route: 'Intravenous/Intramuscular', atc: 'N02AA01', cls: 'Opioid analgesic', category: 'DRUG-CNS', keml: true, salesClass: SalesClass.CD, uom: 'AMP', schedule: ControlledSchedule.SCHEDULE_I, storage: 'Controlled drugs cabinet, double lock',
    brands: [['Morphine Sulfate Injection', 'Martindale', '10 ampoules', 120], ['Morphine Injection UCL', UCL, '10 ampoules', 95]] }),
  g({ inn: 'Pethidine hydrochloride', strength: '50 mg/mL', form: 'Injection', route: 'Intramuscular', atc: 'N02AB02', cls: 'Opioid analgesic', category: 'DRUG-CNS', keml: true, salesClass: SalesClass.CD, uom: 'AMP', schedule: ControlledSchedule.SCHEDULE_I, storage: 'Controlled drugs cabinet, double lock',
    brands: [['Pethidine Injection', 'Martindale', '10 ampoules', 140]] }),
  // Anti-infectives
  g({ inn: 'Amoxicillin', strength: '500 mg', form: 'Capsule', route: 'Oral', atc: 'J01CA04', cls: 'Penicillin antibiotic', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'CAP', pregnancy: 'Compatible', lactation: 'Compatible',
    brands: [['Amoxil', 'GlaxoSmithKline', '10x10', 22.0], ['Amoxicillin Cosmos', COSMOS, '10x10', 4.0], ['Amoxicillin Dawa', DAWA, '10x10', 3.8], ['Moxacil', LAB, '10x10', 4.2]] }),
  g({ inn: 'Amoxicillin', strength: '250 mg/5 mL', form: 'Powder for suspension', route: 'Oral', atc: 'J01CA04', cls: 'Penicillin antibiotic', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'BTL',
    brands: [['Amoxil Suspension', 'GlaxoSmithKline', '100 mL', 520], ['Amoxicillin Suspension Cosmos', COSMOS, '100 mL', 120]] }),
  g({ inn: 'Amoxicillin + Clavulanic acid', strength: '625 mg', form: 'Tablet', route: 'Oral', atc: 'J01CR02', cls: 'Penicillin + beta-lactamase inhibitor', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Augmentin', 'GlaxoSmithKline', '2x7', 95.0], ['Curam', 'Sandoz', '2x7', 70.0], ['Amoxiclav Cosmos', COSMOS, '2x7', 28.0]] }),
  g({ inn: 'Flucloxacillin', strength: '500 mg', form: 'Capsule', route: 'Oral', atc: 'J01CF05', cls: 'Penicillin antibiotic', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'CAP',
    brands: [['Floxapen', 'Actavis', '10x10', 30.0], ['Flucloxacillin Dawa', DAWA, '10x10', 6.5]] }),
  g({ inn: 'Ceftriaxone', strength: '1 g', form: 'Powder for injection', route: 'Intravenous/Intramuscular', atc: 'J01DD04', cls: 'Third-generation cephalosporin', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'VIAL',
    brands: [['Rocephin', 'Roche', '1 vial', 1200], ['Ceftriaxone UCL', UCL, '1 vial', 120], ['Triaxone', 'Laboratory & Allied Ltd', '1 vial', 140]] }),
  g({ inn: 'Cefuroxime', strength: '500 mg', form: 'Tablet', route: 'Oral', atc: 'J01DC02', cls: 'Second-generation cephalosporin', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Zinnat', 'GlaxoSmithKline', '1x10', 160.0], ['Cefuroxime Cosmos', COSMOS, '1x10', 45.0]] }),
  g({ inn: 'Ciprofloxacin', strength: '500 mg', form: 'Tablet', route: 'Oral', atc: 'J01MA02', cls: 'Fluoroquinolone', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'TAB', pregnancy: 'Avoid',
    brands: [['Ciproxin', 'Bayer', '1x10', 110.0], ['Ciprofloxacin Cosmos', COSMOS, '10x10', 5.0], ['Ciprofloxacin Regal', REGAL, '10x10', 4.8]] }),
  g({ inn: 'Metronidazole', strength: '400 mg', form: 'Tablet', route: 'Oral', atc: 'P01AB01', cls: 'Nitroimidazole antibacterial / antiprotozoal', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Flagyl', 'Sanofi', '10x10', 15.0], ['Metronidazole Dawa', DAWA, '10x10', 1.2], ['Metronidazole Elys', ELYS, '100x10', 1.0]] }),
  g({ inn: 'Metronidazole', strength: '500 mg/100 mL', form: 'Infusion', route: 'Intravenous', atc: 'J01XD01', cls: 'Nitroimidazole antibacterial', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'BTL',
    brands: [['Metronidazole IV UCL', UCL, '100 mL', 95], ['Metronidazole Infusion Fresenius', 'Fresenius Kabi', '100 mL', 160]] }),
  g({ inn: 'Azithromycin', strength: '500 mg', form: 'Tablet', route: 'Oral', atc: 'J01FA10', cls: 'Macrolide', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Zithromax', 'Pfizer', '1x3', 350.0], ['Azithromycin Cosmos', COSMOS, '1x3', 60.0], ['Azithral', 'Alembic', '1x3', 75.0]] }),
  g({ inn: 'Doxycycline', strength: '100 mg', form: 'Capsule', route: 'Oral', atc: 'J01AA02', cls: 'Tetracycline', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'CAP', pregnancy: 'Avoid',
    brands: [['Doxycycline Cosmos', COSMOS, '10x10', 3.0], ['Doxycycline Dawa', DAWA, '10x10', 2.8]] }),
  g({ inn: 'Gentamicin', strength: '80 mg/2 mL', form: 'Injection', route: 'Intravenous/Intramuscular', atc: 'J01GB03', cls: 'Aminoglycoside', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'AMP',
    brands: [['Gentamicin Injection UCL', UCL, '10 ampoules', 25], ['Garamycin', 'MSD', '10 ampoules', 90]] }),
  g({ inn: 'Sulfamethoxazole + Trimethoprim', strength: '800 mg + 160 mg', form: 'Tablet', route: 'Oral', atc: 'J01EE01', cls: 'Sulfonamide combination', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Septrin DS', 'Aspen', '10x10', 9.0], ['Cotrimoxazole DS Cosmos', COSMOS, '10x10', 2.0]] }),
  g({ inn: 'Nitrofurantoin', strength: '100 mg', form: 'Tablet', route: 'Oral', atc: 'J01XE01', cls: 'Urinary antiseptic', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Nitrofurantoin Dawa', DAWA, '10x10', 4.0]] }),
  g({ inn: 'Fluconazole', strength: '150 mg', form: 'Capsule', route: 'Oral', atc: 'J02AC01', cls: 'Azole antifungal', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.P, uom: 'CAP',
    brands: [['Diflucan', 'Pfizer', '1x1', 650.0], ['Fluconazole Cosmos', COSMOS, '1x1', 50.0], ['Flucoz', BETA, '1x1', 60.0]] }),
  g({ inn: 'Artemether + Lumefantrine', strength: '20 mg + 120 mg', form: 'Tablet', route: 'Oral', atc: 'P01BF01', cls: 'Antimalarial (ACT)', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Coartem', 'Novartis', '1x24', 25.0], ['Lumartem', 'Cipla', '1x24', 9.0], ['Artefan', 'Ajanta', '1x24', 8.5]] }),
  g({ inn: 'Dihydroartemisinin + Piperaquine', strength: '40 mg + 320 mg', form: 'Tablet', route: 'Oral', atc: 'P01BF05', cls: 'Antimalarial (ACT)', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Duo-Cotecxin', 'Holley-Cotec', '1x9', 45.0], ['P-Alaxin', 'Bliss GVS', '1x9', 42.0]] }),
  g({ inn: 'Artesunate', strength: '60 mg', form: 'Powder for injection', route: 'Intravenous/Intramuscular', atc: 'P01BE03', cls: 'Antimalarial (severe malaria)', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'VIAL',
    brands: [['Artesun', 'Fosun Pharma', '1 vial', 380], ['Larinate', 'Ipca', '1 vial', 350]] }),
  g({ inn: 'Albendazole', strength: '400 mg', form: 'Tablet (chewable)', route: 'Oral', atc: 'P02CA03', cls: 'Anthelmintic', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.P, uom: 'TAB', pregnancy: 'Avoid in first trimester',
    brands: [['Zentel', 'GlaxoSmithKline', '1x1', 120.0], ['Albendazole Cosmos', COSMOS, '1x1', 15.0]] }),
  g({ inn: 'Aciclovir', strength: '400 mg', form: 'Tablet', route: 'Oral', atc: 'J05AB01', cls: 'Antiviral', category: 'DRUG-ANTIINF', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Zovirax', 'GlaxoSmithKline', '5x10', 70.0], ['Acyclovir Cosmos', COSMOS, '5x10', 9.0]] }),
  // Cardiovascular
  g({ inn: 'Amlodipine', strength: '5 mg', form: 'Tablet', route: 'Oral', atc: 'C08CA01', cls: 'Calcium channel blocker', category: 'DRUG-CVS', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Norvasc', 'Pfizer', '3x10', 45.0], ['Amlodipine Cosmos', COSMOS, '10x10', 2.5], ['Amlozaar', 'Laboratory & Allied Ltd', '3x10', 4.0]] }),
  g({ inn: 'Enalapril', strength: '10 mg', form: 'Tablet', route: 'Oral', atc: 'C09AA02', cls: 'ACE inhibitor', category: 'DRUG-CVS', keml: true, salesClass: SalesClass.POM, uom: 'TAB', pregnancy: 'Contraindicated',
    brands: [['Renitec', 'MSD', '3x10', 35.0], ['Enalapril Dawa', DAWA, '10x10', 2.5]] }),
  g({ inn: 'Losartan potassium', strength: '50 mg', form: 'Tablet', route: 'Oral', atc: 'C09CA01', cls: 'Angiotensin II receptor blocker', category: 'DRUG-CVS', keml: true, salesClass: SalesClass.POM, uom: 'TAB', pregnancy: 'Contraindicated',
    brands: [['Cozaar', 'MSD', '3x10', 70.0], ['Losartan Cosmos', COSMOS, '3x10', 8.0], ['Losacar', 'Cadila', '3x10', 10.0]] }),
  g({ inn: 'Hydrochlorothiazide', strength: '25 mg', form: 'Tablet', route: 'Oral', atc: 'C03AA03', cls: 'Thiazide diuretic', category: 'DRUG-CVS', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Hydrochlorothiazide Dawa', DAWA, '10x10', 1.0]] }),
  g({ inn: 'Furosemide', strength: '40 mg', form: 'Tablet', route: 'Oral', atc: 'C03CA01', cls: 'Loop diuretic', category: 'DRUG-CVS', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Lasix', 'Sanofi', '10x10', 12.0], ['Furosemide Cosmos', COSMOS, '10x10', 1.2]] }),
  g({ inn: 'Furosemide', strength: '20 mg/2 mL', form: 'Injection', route: 'Intravenous/Intramuscular', atc: 'C03CA01', cls: 'Loop diuretic', category: 'DRUG-CVS', keml: true, salesClass: SalesClass.POM, uom: 'AMP',
    brands: [['Lasix Injection', 'Sanofi', '5 ampoules', 110], ['Furosemide Injection UCL', UCL, '10 ampoules', 30]] }),
  g({ inn: 'Atenolol', strength: '50 mg', form: 'Tablet', route: 'Oral', atc: 'C07AB03', cls: 'Beta blocker', category: 'DRUG-CVS', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Tenormin', 'AstraZeneca', '2x14', 30.0], ['Atenolol Cosmos', COSMOS, '10x10', 1.5]] }),
  g({ inn: 'Atorvastatin', strength: '20 mg', form: 'Tablet', route: 'Oral', atc: 'C10AA05', cls: 'Statin', category: 'DRUG-CVS', keml: true, salesClass: SalesClass.POM, uom: 'TAB', pregnancy: 'Contraindicated',
    brands: [['Lipitor', 'Pfizer', '3x10', 95.0], ['Atorvastatin Cosmos', COSMOS, '3x10', 10.0], ['Atorva', 'Zydus', '3x10', 12.0]] }),
  g({ inn: 'Acetylsalicylic acid', strength: '75 mg', form: 'Tablet (dispersible)', route: 'Oral', atc: 'B01AC06', cls: 'Antiplatelet', category: 'DRUG-CVS', keml: true, salesClass: SalesClass.P, uom: 'TAB',
    brands: [['Ecotrin', 'Haleon', '3x10', 6.0], ['Aspirin Low Dose Dawa', DAWA, '10x10', 0.7]] }),
  g({ inn: 'Heparin sodium', strength: '5000 IU/mL', form: 'Injection', route: 'Intravenous/Subcutaneous', atc: 'B01AB01', cls: 'Anticoagulant', category: 'DRUG-CVS', keml: true, salesClass: SalesClass.POM, uom: 'VIAL',
    brands: [['Heparin Injection', 'Pfizer', '5 mL vial', 650]] }),
  g({ inn: 'Enoxaparin sodium', strength: '40 mg/0.4 mL', form: 'Injection (prefilled syringe)', route: 'Subcutaneous', atc: 'B01AB05', cls: 'Low molecular weight heparin', category: 'DRUG-CVS', keml: true, salesClass: SalesClass.POM, uom: 'PCS',
    brands: [['Clexane', 'Sanofi', '2 syringes', 850], ['Enoxarin', 'Gland Pharma', '1 syringe', 520]] }),
  // Endocrine
  g({ inn: 'Metformin hydrochloride', strength: '500 mg', form: 'Tablet', route: 'Oral', atc: 'A10BA02', cls: 'Biguanide antidiabetic', category: 'DRUG-ENDO', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Glucophage', 'Merck', '10x10', 9.0], ['Metformin Cosmos', COSMOS, '10x10', 1.2], ['Metformin Dawa', DAWA, '10x10', 1.1]] }),
  g({ inn: 'Glibenclamide', strength: '5 mg', form: 'Tablet', route: 'Oral', atc: 'A10BB01', cls: 'Sulfonylurea', category: 'DRUG-ENDO', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Daonil', 'Sanofi', '10x10', 7.0], ['Glibenclamide Dawa', DAWA, '10x10', 0.8]] }),
  g({ inn: 'Insulin soluble (human)', strength: '100 IU/mL', form: 'Injection', route: 'Subcutaneous/Intravenous', atc: 'A10AB01', cls: 'Short-acting insulin', category: 'DRUG-ENDO', keml: true, salesClass: SalesClass.POM, uom: 'VIAL', cold: true, storage: COLD,
    brands: [['Actrapid', 'Novo Nordisk', '10 mL vial', 1100], ['Insuman Rapid', 'Sanofi', '10 mL vial', 1050]] }),
  g({ inn: 'Insulin isophane (human)', strength: '100 IU/mL', form: 'Injection', route: 'Subcutaneous', atc: 'A10AC01', cls: 'Intermediate-acting insulin', category: 'DRUG-ENDO', keml: true, salesClass: SalesClass.POM, uom: 'VIAL', cold: true, storage: COLD,
    brands: [['Insulatard', 'Novo Nordisk', '10 mL vial', 1100]] }),
  g({ inn: 'Insulin biphasic (human 30/70)', strength: '100 IU/mL', form: 'Injection', route: 'Subcutaneous', atc: 'A10AD01', cls: 'Premixed insulin', category: 'DRUG-ENDO', keml: true, salesClass: SalesClass.POM, uom: 'VIAL', cold: true, storage: COLD,
    brands: [['Mixtard 30', 'Novo Nordisk', '10 mL vial', 1150], ['Humulin 30/70', 'Eli Lilly', '10 mL vial', 1200]] }),
  g({ inn: 'Levothyroxine sodium', strength: '50 mcg', form: 'Tablet', route: 'Oral', atc: 'H03AA01', cls: 'Thyroid hormone', category: 'DRUG-ENDO', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Euthyrox', 'Merck', '4x25', 6.0], ['Eltroxin', 'Aspen', '1x28', 8.0]] }),
  g({ inn: 'Prednisolone', strength: '5 mg', form: 'Tablet', route: 'Oral', atc: 'H02AB06', cls: 'Corticosteroid', category: 'DRUG-ENDO', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Prednisolone Dawa', DAWA, '10x10', 0.8], ['Prednisolone Cosmos', COSMOS, '100x10', 0.7]] }),
  g({ inn: 'Dexamethasone', strength: '4 mg/mL', form: 'Injection', route: 'Intravenous/Intramuscular', atc: 'H02AB02', cls: 'Corticosteroid', category: 'DRUG-ENDO', keml: true, salesClass: SalesClass.POM, uom: 'AMP',
    brands: [['Dexamethasone Injection UCL', UCL, '10 ampoules', 30], ['Decadron', 'MSD', '10 ampoules', 95]] }),
  g({ inn: 'Hydrocortisone sodium succinate', strength: '100 mg', form: 'Powder for injection', route: 'Intravenous/Intramuscular', atc: 'H02AB09', cls: 'Corticosteroid', category: 'DRUG-ENDO', keml: true, salesClass: SalesClass.POM, uom: 'VIAL',
    brands: [['Solu-Cortef', 'Pfizer', '1 vial', 450], ['Hydrocortisone Injection UCL', UCL, '1 vial', 150]] }),
  // GIT
  g({ inn: 'Omeprazole', strength: '20 mg', form: 'Capsule', route: 'Oral', atc: 'A02BC01', cls: 'Proton pump inhibitor', category: 'DRUG-GIT', keml: true, salesClass: SalesClass.P, uom: 'CAP',
    brands: [['Losec', 'AstraZeneca', '2x14', 75.0], ['Omeprazole Cosmos', COSMOS, '10x10', 3.0], ['Omez', "Dr. Reddy's", '10x10', 5.0]] }),
  g({ inn: 'Esomeprazole', strength: '40 mg', form: 'Tablet', route: 'Oral', atc: 'A02BC05', cls: 'Proton pump inhibitor', category: 'DRUG-GIT', keml: false, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Nexium', 'AstraZeneca', '2x14', 140.0], ['Esomeprazole Cosmos', COSMOS, '2x14', 20.0]] }),
  g({ inn: 'Omeprazole', strength: '40 mg', form: 'Powder for injection', route: 'Intravenous', atc: 'A02BC01', cls: 'Proton pump inhibitor', category: 'DRUG-GIT', keml: true, salesClass: SalesClass.POM, uom: 'VIAL',
    brands: [['Losec IV', 'AstraZeneca', '1 vial', 1100], ['Omeprazole IV UCL', UCL, '1 vial', 250]] }),
  g({ inn: 'Metoclopramide', strength: '10 mg', form: 'Tablet', route: 'Oral', atc: 'A03FA01', cls: 'Antiemetic / prokinetic', category: 'DRUG-GIT', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Plasil', 'Sanofi', '10x10', 6.0], ['Metoclopramide Dawa', DAWA, '10x10', 1.0]] }),
  g({ inn: 'Ondansetron', strength: '4 mg/2 mL', form: 'Injection', route: 'Intravenous', atc: 'A04AA01', cls: '5-HT3 antiemetic', category: 'DRUG-GIT', keml: true, salesClass: SalesClass.POM, uom: 'AMP',
    brands: [['Zofran', 'Novartis', '5 ampoules', 380], ['Emeset', 'Cipla', '5 ampoules', 90]] }),
  g({ inn: 'Oral rehydration salts', strength: '20.5 g/L', form: 'Powder for oral solution', route: 'Oral', atc: 'A07CA', cls: 'Oral rehydration', category: 'DRUG-GIT', keml: true, salesClass: SalesClass.OTC, uom: 'SACHET',
    brands: [['ORS Cosmos', COSMOS, '25 sachets', 20], ['Oralite', 'Medisel', '25 sachets', 25]] }),
  g({ inn: 'Zinc sulfate', strength: '20 mg', form: 'Tablet (dispersible)', route: 'Oral', atc: 'A12CB01', cls: 'Mineral supplement', category: 'DRUG-VIT', keml: true, salesClass: SalesClass.OTC, uom: 'TAB',
    brands: [['Zinkid', 'Cosmos Ltd', '10x10', 5.0]] }),
  g({ inn: 'Hyoscine butylbromide', strength: '10 mg', form: 'Tablet', route: 'Oral', atc: 'A03BB01', cls: 'Antispasmodic', category: 'DRUG-GIT', keml: true, salesClass: SalesClass.P, uom: 'TAB',
    brands: [['Buscopan', 'Sanofi', '2x10', 18.0], ['Hyoscine Cosmos', COSMOS, '10x10', 2.5]] }),
  // Respiratory & allergy
  g({ inn: 'Salbutamol', strength: '100 mcg/dose', form: 'Inhaler (MDI)', route: 'Inhalation', atc: 'R03AC02', cls: 'Short-acting beta-2 agonist', category: 'DRUG-RESP', keml: true, salesClass: SalesClass.POM, uom: 'INH',
    brands: [['Ventolin Evohaler', 'GlaxoSmithKline', '200 doses', 650], ['Asthalin', 'Cipla', '200 doses', 380]] }),
  g({ inn: 'Salbutamol', strength: '5 mg/mL', form: 'Nebuliser solution', route: 'Inhalation', atc: 'R03AC02', cls: 'Short-acting beta-2 agonist', category: 'DRUG-RESP', keml: true, salesClass: SalesClass.POM, uom: 'BTL',
    brands: [['Ventolin Respirator Solution', 'GlaxoSmithKline', '20 mL', 900]] }),
  g({ inn: 'Beclometasone dipropionate', strength: '100 mcg/dose', form: 'Inhaler (MDI)', route: 'Inhalation', atc: 'R03BA01', cls: 'Inhaled corticosteroid', category: 'DRUG-RESP', keml: true, salesClass: SalesClass.POM, uom: 'INH',
    brands: [['Clenil Modulite', 'Chiesi', '200 doses', 900], ['Beclate', 'Cipla', '200 doses', 600]] }),
  g({ inn: 'Cetirizine', strength: '10 mg', form: 'Tablet', route: 'Oral', atc: 'R06AE07', cls: 'Antihistamine', category: 'DRUG-RESP', keml: true, salesClass: SalesClass.OTC, uom: 'TAB',
    brands: [['Zyrtec', 'UCB', '1x10', 45.0], ['Cetirizine Cosmos', COSMOS, '10x10', 1.5], ['Cetrizet', 'Sun Pharma', '1x10', 6.0]] }),
  g({ inn: 'Chlorphenamine maleate', strength: '4 mg', form: 'Tablet', route: 'Oral', atc: 'R06AB04', cls: 'Antihistamine', category: 'DRUG-RESP', keml: true, salesClass: SalesClass.OTC, uom: 'TAB',
    brands: [['Piriton', 'Haleon', '3x10', 4.0], ['Chlorpheniramine Dawa', DAWA, '100x10', 0.3]] }),
  g({ inn: 'Aminophylline', strength: '250 mg/10 mL', form: 'Injection', route: 'Intravenous', atc: 'R03DA05', cls: 'Methylxanthine bronchodilator', category: 'DRUG-RESP', keml: true, salesClass: SalesClass.POM, uom: 'AMP',
    brands: [['Aminophylline Injection UCL', UCL, '10 ampoules', 45]] }),
  // CNS, anaesthesia
  g({ inn: 'Diazepam', strength: '10 mg/2 mL', form: 'Injection', route: 'Intravenous/Rectal', atc: 'N05BA01', cls: 'Benzodiazepine', category: 'DRUG-CNS', keml: true, salesClass: SalesClass.CD, uom: 'AMP', schedule: ControlledSchedule.SCHEDULE_IV, storage: 'Controlled drugs cabinet',
    brands: [['Valium Injection', 'Roche', '10 ampoules', 180], ['Diazepam Injection UCL', UCL, '10 ampoules', 45]] }),
  g({ inn: 'Diazepam', strength: '5 mg', form: 'Tablet', route: 'Oral', atc: 'N05BA01', cls: 'Benzodiazepine', category: 'DRUG-CNS', keml: true, salesClass: SalesClass.CD, uom: 'TAB', schedule: ControlledSchedule.SCHEDULE_IV, storage: 'Controlled drugs cabinet',
    brands: [['Diazepam Tablets Dawa', DAWA, '10x10', 1.0]] }),
  g({ inn: 'Ketamine', strength: '50 mg/mL', form: 'Injection', route: 'Intravenous/Intramuscular', atc: 'N01AX03', cls: 'General anaesthetic', category: 'DRUG-CNS', keml: true, salesClass: SalesClass.CD, uom: 'VIAL', schedule: ControlledSchedule.SCHEDULE_III, storage: 'Controlled drugs cabinet',
    brands: [['Ketalar', 'Pfizer', '10 mL vial', 900], ['Ketamine Injection Rotex', 'Rotexmedica', '10 mL vial', 500]] }),
  g({ inn: 'Propofol', strength: '10 mg/mL', form: 'Emulsion for injection', route: 'Intravenous', atc: 'N01AX10', cls: 'General anaesthetic', category: 'DRUG-CNS', keml: true, salesClass: SalesClass.POM, uom: 'AMP',
    brands: [['Diprivan', 'Aspen', '20 mL ampoule', 750], ['Propofol Fresenius', 'Fresenius Kabi', '20 mL ampoule', 420]] }),
  g({ inn: 'Lidocaine hydrochloride', strength: '2%', form: 'Injection', route: 'Infiltration', atc: 'N01BB02', cls: 'Local anaesthetic', category: 'DRUG-CNS', keml: true, salesClass: SalesClass.POM, uom: 'VIAL',
    brands: [['Xylocaine 2%', 'Aspen', '20 mL vial', 380], ['Lignocaine 2% UCL', UCL, '30 mL vial', 120]] }),
  g({ inn: 'Bupivacaine (heavy)', strength: '0.5%', form: 'Injection (spinal)', route: 'Intrathecal', atc: 'N01BB01', cls: 'Local anaesthetic (spinal)', category: 'DRUG-CNS', keml: true, salesClass: SalesClass.POM, uom: 'AMP',
    brands: [['Marcaine Heavy', 'Aspen', '5x4 mL', 290], ['Bupivacaine Heavy Claris', 'Claris', '5x4 mL', 180]] }),
  g({ inn: 'Phenobarbital', strength: '30 mg', form: 'Tablet', route: 'Oral', atc: 'N03AA02', cls: 'Anticonvulsant', category: 'DRUG-CNS', keml: true, salesClass: SalesClass.CD, uom: 'TAB', schedule: ControlledSchedule.SCHEDULE_IV,
    brands: [['Phenobarbitone Dawa', DAWA, '10x10', 1.2]] }),
  g({ inn: 'Carbamazepine', strength: '200 mg', form: 'Tablet', route: 'Oral', atc: 'N03AF01', cls: 'Anticonvulsant', category: 'DRUG-CNS', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Tegretol', 'Novartis', '5x10', 22.0], ['Carbamazepine Cosmos', COSMOS, '10x10', 4.0]] }),
  g({ inn: 'Amitriptyline', strength: '25 mg', form: 'Tablet', route: 'Oral', atc: 'N06AA09', cls: 'Tricyclic antidepressant', category: 'DRUG-CNS', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Amitriptyline Dawa', DAWA, '10x10', 1.0]] }),
  // Fluids
  g({ inn: 'Sodium chloride', strength: '0.9%', form: 'Infusion', route: 'Intravenous', atc: 'B05BB01', cls: 'IV fluid (crystalloid)', category: 'DRUG-FLUIDS', keml: true, salesClass: SalesClass.POM, uom: 'BTL', tax: 'ZERO',
    brands: [['Normal Saline 500 mL Fresenius', 'Fresenius Kabi', '500 mL', 95], ['Normal Saline 500 mL Dawa', DAWA, '500 mL', 70], ['Normal Saline 1 L Dawa', DAWA, '1000 mL', 110]] }),
  g({ inn: "Compound sodium lactate (Ringer's lactate)", strength: '—', form: 'Infusion', route: 'Intravenous', atc: 'B05BB01', cls: 'IV fluid (crystalloid)', category: 'DRUG-FLUIDS', keml: true, salesClass: SalesClass.POM, uom: 'BTL', tax: 'ZERO',
    brands: [["Ringer's Lactate Fresenius", 'Fresenius Kabi', '500 mL', 100], ["Ringer's Lactate Dawa", DAWA, '500 mL', 75]] }),
  g({ inn: 'Glucose', strength: '5%', form: 'Infusion', route: 'Intravenous', atc: 'B05BA03', cls: 'IV fluid', category: 'DRUG-FLUIDS', keml: true, salesClass: SalesClass.POM, uom: 'BTL', tax: 'ZERO',
    brands: [['Dextrose 5% Dawa', DAWA, '500 mL', 70], ['Dextrose 5% Fresenius', 'Fresenius Kabi', '500 mL', 95]] }),
  g({ inn: 'Glucose', strength: '50%', form: 'Injection', route: 'Intravenous', atc: 'B05BA03', cls: 'Hypertonic glucose', category: 'DRUG-FLUIDS', keml: true, salesClass: SalesClass.POM, uom: 'VIAL', tax: 'ZERO',
    brands: [['Dextrose 50% UCL', UCL, '50 mL', 90]] }),
  g({ inn: 'Potassium chloride', strength: '15% (2 mmol/mL)', form: 'Concentrate for infusion', route: 'Intravenous', atc: 'B05XA01', cls: 'Electrolyte', category: 'DRUG-FLUIDS', keml: true, salesClass: SalesClass.POM, uom: 'AMP', storage: 'High-alert medicine: store separately',
    brands: [['Potassium Chloride 15% UCL', UCL, '10 mL ampoule', 45]] }),
  g({ inn: 'Water for injection', strength: '—', form: 'Injection', route: 'Parenteral', atc: 'V07AB', cls: 'Diluent', category: 'DRUG-FLUIDS', keml: true, salesClass: SalesClass.POM, uom: 'AMP', tax: 'ZERO',
    brands: [['Water for Injection 10 mL UCL', UCL, '10 mL ampoule', 8], ['Water for Injection 5 mL Dawa', DAWA, '5 mL ampoule', 6]] }),
  // Obstetrics
  g({ inn: 'Oxytocin', strength: '10 IU/mL', form: 'Injection', route: 'Intravenous/Intramuscular', atc: 'H01BB02', cls: 'Uterotonic', category: 'DRUG-OBS', keml: true, salesClass: SalesClass.POM, uom: 'AMP', cold: true, storage: COLD,
    brands: [['Syntocinon', 'Mylan', '5 ampoules', 120], ['Oxytocin Injection Rotex', 'Rotexmedica', '10 ampoules', 60]] }),
  g({ inn: 'Misoprostol', strength: '200 mcg', form: 'Tablet', route: 'Oral/Sublingual', atc: 'G02AD06', cls: 'Prostaglandin', category: 'DRUG-OBS', keml: true, salesClass: SalesClass.POM, uom: 'TAB',
    brands: [['Cytotec', 'Pfizer', '1x28', 60.0], ['Misoclear', 'Acme', '1x4', 45.0]] }),
  g({ inn: 'Magnesium sulfate', strength: '50%', form: 'Injection', route: 'Intravenous/Intramuscular', atc: 'B05XA05', cls: 'Anticonvulsant (eclampsia)', category: 'DRUG-OBS', keml: true, salesClass: SalesClass.POM, uom: 'AMP',
    brands: [['Magnesium Sulphate 50% UCL', UCL, '10 ampoules', 60]] }),
  g({ inn: 'Ferrous sulfate + Folic acid', strength: '200 mg + 0.4 mg', form: 'Tablet', route: 'Oral', atc: 'B03AD03', cls: 'Haematinic', category: 'DRUG-VIT', keml: true, salesClass: SalesClass.OTC, uom: 'TAB',
    brands: [['Ranferon', 'Ranbaxy', '3x10', 6.0], ['Ferrous + Folic Dawa', DAWA, '100x10', 0.4]] }),
  g({ inn: 'Clotrimazole', strength: '500 mg', form: 'Pessary', route: 'Vaginal', atc: 'G01AF02', cls: 'Azole antifungal', category: 'DRUG-OBS', keml: true, salesClass: SalesClass.P, uom: 'PESS',
    brands: [['Canesten Pessary', 'Bayer', '1 pessary', 420], ['Clozole', BETA, '1 pessary', 120]] }),
  g({ inn: 'Medroxyprogesterone acetate', strength: '150 mg/mL', form: 'Injection', route: 'Intramuscular', atc: 'G03AC06', cls: 'Contraceptive', category: 'DRUG-OBS', keml: true, salesClass: SalesClass.POM, uom: 'VIAL',
    brands: [['Depo-Provera', 'Pfizer', '1 vial', 250]] }),
  // Vaccines & sera
  g({ inn: 'Tetanus toxoid', strength: '0.5 mL/dose', form: 'Injection', route: 'Intramuscular', atc: 'J07AM01', cls: 'Vaccine', category: 'DRUG-VACC', keml: true, salesClass: SalesClass.POM, uom: 'VIAL', cold: true, storage: COLD,
    brands: [['TT Vaccine Serum Institute', 'Serum Institute of India', '10-dose vial', 350]] }),
  g({ inn: 'Hepatitis B vaccine', strength: '20 mcg/mL', form: 'Injection', route: 'Intramuscular', atc: 'J07BC01', cls: 'Vaccine', category: 'DRUG-VACC', keml: true, salesClass: SalesClass.POM, uom: 'VIAL', cold: true, storage: COLD,
    brands: [['Engerix-B', 'GlaxoSmithKline', '1 mL vial', 1400], ['Gene Vac-B', 'Serum Institute of India', '1 mL vial', 650]] }),
  g({ inn: 'Rabies vaccine', strength: '2.5 IU/dose', form: 'Powder for injection', route: 'Intramuscular', atc: 'J07BG01', cls: 'Vaccine', category: 'DRUG-VACC', keml: true, salesClass: SalesClass.POM, uom: 'VIAL', cold: true, storage: COLD,
    brands: [['Verorab', 'Sanofi', '1 dose', 1900], ['Rabivax-S', 'Serum Institute of India', '1 dose', 1300]] }),
  g({ inn: 'Anti-tetanus immunoglobulin', strength: '250 IU', form: 'Injection', route: 'Intramuscular', atc: 'J06BB02', cls: 'Immunoglobulin', category: 'DRUG-VACC', keml: true, salesClass: SalesClass.POM, uom: 'AMP', cold: true, storage: COLD,
    brands: [['Tetagam P', 'CSL Behring', '1 mL', 2500]] }),
  // Dermatology & eye
  g({ inn: 'Silver sulfadiazine', strength: '1%', form: 'Cream', route: 'Topical', atc: 'D06BA01', cls: 'Topical antibacterial (burns)', category: 'DRUG-DERM', keml: true, salesClass: SalesClass.P, uom: 'TUBE',
    brands: [['Flamazine', 'Smith & Nephew', '50 g', 650], ['Silverex', 'Sun Pharma', '25 g', 220]] }),
  g({ inn: 'Clotrimazole', strength: '1%', form: 'Cream', route: 'Topical', atc: 'D01AC01', cls: 'Topical antifungal', category: 'DRUG-DERM', keml: true, salesClass: SalesClass.OTC, uom: 'TUBE',
    brands: [['Canesten Cream', 'Bayer', '20 g', 380], ['Clotrimazole Cream Beta', BETA, '20 g', 90]] }),
  g({ inn: 'Hydrocortisone', strength: '1%', form: 'Cream', route: 'Topical', atc: 'D07AA02', cls: 'Topical corticosteroid', category: 'DRUG-DERM', keml: true, salesClass: SalesClass.P, uom: 'TUBE',
    brands: [['Hydrocortisone Cream Beta', BETA, '15 g', 80]] }),
  g({ inn: 'Povidone-iodine', strength: '10%', form: 'Solution', route: 'Topical', atc: 'D08AG02', cls: 'Antiseptic', category: 'DRUG-DERM', keml: true, salesClass: SalesClass.OTC, uom: 'BTL',
    brands: [['Betadine', 'Mundipharma', '500 mL', 1300], ['Povidone Iodine Elys', ELYS, '500 mL', 450]] }),
  g({ inn: 'Tetracycline', strength: '1%', form: 'Eye ointment', route: 'Ophthalmic', atc: 'S01AA09', cls: 'Ophthalmic antibiotic', category: 'DRUG-DERM', keml: true, salesClass: SalesClass.P, uom: 'TUBE',
    brands: [['Tetracycline Eye Ointment Beta', BETA, '3.5 g', 60]] }),
  // Vitamins
  g({ inn: 'Folic acid', strength: '5 mg', form: 'Tablet', route: 'Oral', atc: 'B03BB01', cls: 'Vitamin', category: 'DRUG-VIT', keml: true, salesClass: SalesClass.OTC, uom: 'TAB',
    brands: [['Folic Acid Dawa', DAWA, '100x10', 0.3]] }),
  g({ inn: 'Vitamin B complex', strength: '—', form: 'Tablet', route: 'Oral', atc: 'A11EA', cls: 'Vitamin', category: 'DRUG-VIT', keml: false, salesClass: SalesClass.OTC, uom: 'TAB',
    brands: [['Vitamin B Complex Elys', ELYS, '100x10', 0.4]] }),
  g({ inn: 'Phytomenadione (Vitamin K1)', strength: '1 mg/0.5 mL', form: 'Injection', route: 'Intramuscular', atc: 'B02BA01', cls: 'Vitamin K', category: 'DRUG-VIT', keml: true, salesClass: SalesClass.POM, uom: 'AMP',
    brands: [['Konakion MM Paediatric', 'Roche', '5 ampoules', 250], ['Vitamin K1 Injection Rotex', 'Rotexmedica', '10 ampoules', 70]] }),
];

export interface SampleSupply {
  name: string;
  category: string;
  manufacturer: string;
  pack: string;
  uom: string;
  price: number;
  tax: string;
  attributes: Record<string, string | number | boolean>;
}

const s = (x: SampleSupply) => x;

export const SAMPLE_SUPPLIES: SampleSupply[] = [
  s({ name: 'Examination gloves, nitrile, powder-free, S', category: 'SUP-PPE', manufacturer: 'Supermax', pack: 'Box of 100', uom: 'PCS', price: 9, tax: 'STANDARD', attributes: { size: 'S', material: 'Nitrile', sterile: false } }),
  s({ name: 'Examination gloves, nitrile, powder-free, M', category: 'SUP-PPE', manufacturer: 'Supermax', pack: 'Box of 100', uom: 'PCS', price: 9, tax: 'STANDARD', attributes: { size: 'M', material: 'Nitrile', sterile: false } }),
  s({ name: 'Examination gloves, nitrile, powder-free, L', category: 'SUP-PPE', manufacturer: 'Supermax', pack: 'Box of 100', uom: 'PCS', price: 9, tax: 'STANDARD', attributes: { size: 'L', material: 'Nitrile', sterile: false } }),
  s({ name: 'Surgical gloves, latex, sterile, size 7', category: 'SUP-PPE', manufacturer: 'Ansell', pack: 'Box of 50 pairs', uom: 'PAIR', price: 45, tax: 'STANDARD', attributes: { size: 'M', material: 'Latex', sterile: true } }),
  s({ name: 'Surgical gloves, latex, sterile, size 7.5', category: 'SUP-PPE', manufacturer: 'Ansell', pack: 'Box of 50 pairs', uom: 'PAIR', price: 45, tax: 'STANDARD', attributes: { size: 'L', material: 'Latex', sterile: true } }),
  s({ name: 'Surgical face mask, 3-ply', category: 'SUP-PPE', manufacturer: 'Sample Medical Ltd', pack: 'Box of 50', uom: 'PCS', price: 6, tax: 'STANDARD', attributes: { size: 'Universal', material: 'Non-woven', sterile: false } }),
  s({ name: 'N95 respirator', category: 'SUP-PPE', manufacturer: '3M', pack: 'Box of 20', uom: 'PCS', price: 180, tax: 'STANDARD', attributes: { size: 'Universal', material: 'Polypropylene', sterile: false } }),
  s({ name: 'Disposable apron, plastic', category: 'SUP-PPE', manufacturer: 'Sample Medical Ltd', pack: 'Pack of 100', uom: 'PCS', price: 7, tax: 'STANDARD', attributes: { size: 'Universal', material: 'Polyethylene', sterile: false } }),
  s({ name: 'Theatre cap, disposable', category: 'SUP-PPE', manufacturer: 'Sample Medical Ltd', pack: 'Pack of 100', uom: 'PCS', price: 5, tax: 'STANDARD', attributes: { size: 'Universal', material: 'Non-woven', sterile: false } }),
  s({ name: 'Syringe 2 mL with needle 23G', category: 'SUP-SHARPS', manufacturer: 'BD', pack: 'Box of 100', uom: 'PCS', price: 8, tax: 'ZERO', attributes: { gauge: 23, volumeMl: 2, sterile: true } }),
  s({ name: 'Syringe 5 mL with needle 21G', category: 'SUP-SHARPS', manufacturer: 'BD', pack: 'Box of 100', uom: 'PCS', price: 9, tax: 'ZERO', attributes: { gauge: 21, volumeMl: 5, sterile: true } }),
  s({ name: 'Syringe 10 mL with needle 21G', category: 'SUP-SHARPS', manufacturer: 'BD', pack: 'Box of 100', uom: 'PCS', price: 12, tax: 'ZERO', attributes: { gauge: 21, volumeMl: 10, sterile: true } }),
  s({ name: 'Syringe 20 mL Luer lock', category: 'SUP-SHARPS', manufacturer: 'BD', pack: 'Box of 50', uom: 'PCS', price: 20, tax: 'ZERO', attributes: { volumeMl: 20, sterile: true } }),
  s({ name: 'Insulin syringe 1 mL U-100 30G', category: 'SUP-SHARPS', manufacturer: 'BD', pack: 'Box of 100', uom: 'PCS', price: 15, tax: 'ZERO', attributes: { gauge: 30, volumeMl: 1, sterile: true } }),
  s({ name: 'IV cannula 18G (green)', category: 'SUP-SHARPS', manufacturer: 'BD Venflon', pack: 'Box of 50', uom: 'PCS', price: 55, tax: 'ZERO', attributes: { gauge: 18, sterile: true } }),
  s({ name: 'IV cannula 20G (pink)', category: 'SUP-SHARPS', manufacturer: 'BD Venflon', pack: 'Box of 50', uom: 'PCS', price: 55, tax: 'ZERO', attributes: { gauge: 20, sterile: true } }),
  s({ name: 'IV cannula 22G (blue)', category: 'SUP-SHARPS', manufacturer: 'BD Venflon', pack: 'Box of 50', uom: 'PCS', price: 55, tax: 'ZERO', attributes: { gauge: 22, sterile: true } }),
  s({ name: 'IV cannula 24G (yellow)', category: 'SUP-SHARPS', manufacturer: 'BD Venflon', pack: 'Box of 50', uom: 'PCS', price: 60, tax: 'ZERO', attributes: { gauge: 24, sterile: true } }),
  s({ name: 'IV giving set, adult', category: 'SUP-SHARPS', manufacturer: 'Sample Medical Ltd', pack: 'Box of 100', uom: 'PCS', price: 35, tax: 'ZERO', attributes: { sterile: true } }),
  s({ name: 'Hypodermic needle 23G', category: 'SUP-SHARPS', manufacturer: 'BD', pack: 'Box of 100', uom: 'PCS', price: 3, tax: 'ZERO', attributes: { gauge: 23, sterile: true } }),
  s({ name: 'Sharps container 5 L', category: 'SUP-SHARPS', manufacturer: 'Sample Medical Ltd', pack: 'Each', uom: 'PCS', price: 250, tax: 'STANDARD', attributes: { volumeMl: 5000, sterile: false } }),
  s({ name: 'Gauze swabs 10 x 10 cm, 8-ply, non-sterile', category: 'SUP-DRESS', manufacturer: 'Sample Medical Ltd', pack: 'Pack of 100', uom: 'PCS', price: 3, tax: 'ZERO', attributes: { dimensions: '10x10 cm', sterile: false } }),
  s({ name: 'Gauze swabs 10 x 10 cm, sterile', category: 'SUP-DRESS', manufacturer: 'Sample Medical Ltd', pack: 'Pack of 5', uom: 'PACK', price: 25, tax: 'ZERO', attributes: { dimensions: '10x10 cm', sterile: true } }),
  s({ name: 'Cotton wool 500 g', category: 'SUP-DRESS', manufacturer: 'Elys Chemical Industries', pack: '500 g roll', uom: 'ROLL', price: 320, tax: 'ZERO', attributes: { sterile: false } }),
  s({ name: 'Crepe bandage 10 cm', category: 'SUP-DRESS', manufacturer: 'Sample Medical Ltd', pack: 'Each', uom: 'ROLL', price: 60, tax: 'ZERO', attributes: { dimensions: '10 cm x 4.5 m', sterile: false } }),
  s({ name: 'Adhesive plaster (zinc oxide) 7.5 cm', category: 'SUP-DRESS', manufacturer: 'Sample Medical Ltd', pack: 'Each', uom: 'ROLL', price: 180, tax: 'ZERO', attributes: { dimensions: '7.5 cm x 5 m', sterile: false } }),
  s({ name: 'Transparent IV dressing 6 x 7 cm', category: 'SUP-DRESS', manufacturer: '3M Tegaderm', pack: 'Box of 100', uom: 'PCS', price: 45, tax: 'ZERO', attributes: { dimensions: '6x7 cm', sterile: true } }),
  s({ name: 'Polyglactin 910 (Vicryl) 2-0, 36 mm round body', category: 'SUP-SUTURE', manufacturer: 'Ethicon', pack: 'Box of 12', uom: 'PCS', price: 650, tax: 'ZERO', attributes: { usp: '2-0', absorbable: true, needle: 'Round body' } }),
  s({ name: 'Polyglactin 910 (Vicryl) 3-0, 26 mm round body', category: 'SUP-SUTURE', manufacturer: 'Ethicon', pack: 'Box of 12', uom: 'PCS', price: 650, tax: 'ZERO', attributes: { usp: '3-0', absorbable: true, needle: 'Round body' } }),
  s({ name: 'Nylon 3-0, 24 mm reverse cutting', category: 'SUP-SUTURE', manufacturer: 'Ethicon', pack: 'Box of 12', uom: 'PCS', price: 380, tax: 'ZERO', attributes: { usp: '3-0', absorbable: false, needle: 'Reverse cutting' } }),
  s({ name: 'Chromic catgut 1, 40 mm round body', category: 'SUP-SUTURE', manufacturer: 'Sample Sutures Ltd', pack: 'Box of 12', uom: 'PCS', price: 300, tax: 'ZERO', attributes: { usp: '1', absorbable: true, needle: 'Round body' } }),
  s({ name: 'Malaria rapid diagnostic test (Pf/Pan)', category: 'SUP-LAB', manufacturer: 'Abbott', pack: 'Kit of 25 tests', uom: 'KIT', price: 2500, tax: 'ZERO', attributes: { testsPerKit: 25, storageTemp: '2–30°C' } }),
  s({ name: 'HIV 1/2 rapid test', category: 'SUP-LAB', manufacturer: 'Abbott Determine', pack: 'Kit of 100 tests', uom: 'KIT', price: 9000, tax: 'ZERO', attributes: { testsPerKit: 100, storageTemp: '2–30°C' } }),
  s({ name: 'Urinalysis strips, 10 parameter', category: 'SUP-LAB', manufacturer: 'Roche Combur', pack: 'Tube of 100', uom: 'PACK', price: 3800, tax: 'STANDARD', attributes: { testsPerKit: 100, storageTemp: '2–30°C' } }),
  s({ name: 'Blood glucose test strips', category: 'SUP-LAB', manufacturer: 'Accu-Chek', pack: 'Tube of 50', uom: 'PACK', price: 2200, tax: 'ZERO', attributes: { testsPerKit: 50, storageTemp: '4–30°C' } }),
  s({ name: 'EDTA blood collection tube 4 mL', category: 'SUP-LAB', manufacturer: 'BD Vacutainer', pack: 'Rack of 100', uom: 'PCS', price: 18, tax: 'ZERO', attributes: { storageTemp: '4–25°C' } }),
  s({ name: 'Urinary catheter Foley 2-way 16 Fr', category: 'SUP-GEN', manufacturer: 'Sample Medical Ltd', pack: 'Each', uom: 'PCS', price: 120, tax: 'ZERO', attributes: {} }),
  s({ name: 'Urine drainage bag 2 L', category: 'SUP-GEN', manufacturer: 'Sample Medical Ltd', pack: 'Each', uom: 'BAG', price: 70, tax: 'ZERO', attributes: {} }),
  s({ name: 'Nasogastric tube 14 Fr', category: 'SUP-GEN', manufacturer: 'Sample Medical Ltd', pack: 'Each', uom: 'PCS', price: 60, tax: 'ZERO', attributes: {} }),
  s({ name: 'Alcohol swabs 70% isopropyl', category: 'SUP-GEN', manufacturer: 'Sample Medical Ltd', pack: 'Box of 100', uom: 'PCS', price: 2, tax: 'STANDARD', attributes: {} }),
  s({ name: 'Hand sanitiser 500 mL', category: 'SUP-GEN', manufacturer: 'Elys Chemical Industries', pack: '500 mL', uom: 'BTL', price: 450, tax: 'STANDARD', attributes: {} }),
];
