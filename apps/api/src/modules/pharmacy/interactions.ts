import { EntityManager } from 'typeorm';
import { ClinicalAlertType, InteractionSeverity } from '@sil/shared';

/** A medicine taking part in the checks (a prescription line, or an active medication). */
export interface MedForCheck {
  /** Prescription line id; null for an active medication from an earlier dispense. */
  lineId: string | null;
  genericId: string;
  inn: string;
  therapeuticClass: string | null;
  pregnancyContraindicated: boolean;
  minAgeYears: number | null;
  label: string;
}

export interface InteractionPair {
  innA: string;
  innB: string;
  severity: InteractionSeverity;
  mechanism: string;
  management: string;
  source: string;
}

/**
 * Where interaction pairs come from. The internal source reads the curated
 * drug_interaction table; a licensed knowledge base can implement this later.
 */
export interface InteractionSource {
  readonly name: string;
  /** Pairs where both sides are among `terms` (lower-case INNs and "class:<name>"). */
  find(m: EntityManager, terms: string[]): Promise<InteractionPair[]>;
}

export class InternalInteractionSource implements InteractionSource {
  readonly name = 'INTERNAL';

  async find(m: EntityManager, terms: string[]): Promise<InteractionPair[]> {
    if (terms.length < 2) return [];
    const rows = await m.query(
      `SELECT inn_a, inn_b, severity, mechanism, management, source FROM drug_interaction
        WHERE is_active AND inn_a = ANY($1::text[]) AND inn_b = ANY($1::text[])`,
      [terms],
    );
    return rows.map((r: Record<string, string>) => ({ innA: r.inn_a, innB: r.inn_b, severity: r.severity as InteractionSeverity, mechanism: r.mechanism, management: r.management, source: r.source }));
  }
}

export interface AlertDraft {
  type: ClinicalAlertType;
  severity: InteractionSeverity;
  message: string;
  management: string | null;
  lineIds: string[];
  fingerprint: string;
}

export interface CheckPatient {
  ageYears: number | null;
  isPregnant: boolean;
  allergies: string[];
}

export const norm = (s: string) => s.trim().toLowerCase();
export const classTerm = (c: string) => `class:${norm(c)}`;
/** Substances of a (combination) INN: "Sulfamethoxazole + Trimethoprim" → both. */
export const componentsOf = (inn: string) => inn.split('+').map(norm).filter(Boolean);
/** Terms a medicine is known by: its INN, its components and its therapeutic class. */
export const termsOf = (m: MedForCheck) => [...new Set([norm(m.inn), ...componentsOf(m.inn), ...(m.therapeuticClass ? [classTerm(m.therapeuticClass)] : [])])];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "penicillins" matches class "Penicillin antibiotic"; "sulfonamides" matches "Sulfonamide combination". */
function allergyMatches(allergy: string, m: MedForCheck): boolean {
  const a = norm(allergy).replace(/^class:/, '');
  const stem = a.length > 4 && a.endsWith('s') ? a.slice(0, -1) : a;
  const re = new RegExp(`(^|[^a-z])${escapeRe(stem)}`);
  return [norm(m.inn), ...(m.therapeuticClass ? [norm(m.therapeuticClass)] : [])].some((t) => t === a || re.test(t));
}
/** Interaction pairs are stored with innA < innB. */
export const orderPair = (a: string, b: string): [string, string] => (norm(a) <= norm(b) ? [norm(a), norm(b)] : [norm(b), norm(a)]);

const SEVERITY_RANK: Record<InteractionSeverity, number> = { CONTRAINDICATED: 4, MAJOR: 3, MODERATE: 2, MINOR: 1 };
export const severityRank = (s: InteractionSeverity) => SEVERITY_RANK[s];

/**
 * Generic-level checks of new prescription lines against each other and the
 * patient's active medications: interactions, allergies, duplicate therapy
 * (same substance or same therapeutic class), minimum age and pregnancy.
 * Pure: the interaction pairs are passed in.
 */
export function runChecks(patient: CheckPatient, lines: MedForCheck[], active: MedForCheck[], pairs: InteractionPair[]): AlertDraft[] {
  const out: AlertDraft[] = [];
  const ids = (...meds: MedForCheck[]) => [...new Set(meds.map((x) => x.lineId).filter((x): x is string => !!x))].sort();
  const fp = (type: string, parts: string[], meds: MedForCheck[]) => `${type}|${parts.map(norm).sort().join('+')}|${ids(...meds).join(',')}`.slice(0, 300);

  // Interactions: every new line against the other new lines and active medications.
  const index = new Map<string, InteractionPair>();
  for (const p of pairs) index.set(`${norm(p.innA)}|${norm(p.innB)}`, p);
  const others = [...lines, ...active];
  const seen = new Set<string>();
  for (const a of lines) {
    for (const b of others) {
      if (a === b || a.genericId === b.genericId) continue;
      for (const ta of termsOf(a)) {
        for (const tb of termsOf(b)) {
          const [x, y] = orderPair(ta, tb);
          const hit = index.get(`${x}|${y}`);
          if (!hit) continue;
          const key = `${[a.lineId ?? a.genericId, b.lineId ?? b.genericId].sort().join('~')}|${x}|${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            type: ClinicalAlertType.INTERACTION,
            severity: hit.severity,
            message: `${a.label} + ${b.label}${b.lineId ? '' : ' (active medication)'}: ${hit.mechanism}`,
            management: hit.management,
            lineIds: ids(a, b),
            fingerprint: fp('INTERACTION', [x, y], [a, b]),
          });
        }
      }
    }
  }

  // Allergies: the substance or its class.
  const allergies = patient.allergies.map(norm).filter(Boolean);
  for (const l of lines) {
    const matched = allergies.filter((al) => allergyMatches(al, l));
    if (matched.length) {
      out.push({
        type: ClinicalAlertType.ALLERGY,
        severity: InteractionSeverity.CONTRAINDICATED,
        message: `${l.label}: patient is recorded as allergic to ${matched.join(', ')}`,
        management: 'Do not dispense unless the prescriber confirms the allergy record is wrong.',
        lineIds: ids(l),
        fingerprint: fp('ALLERGY', matched, [l]),
      });
    }
  }

  // Duplicate therapy: same substance, or same therapeutic class.
  const dupSeen = new Set<string>();
  for (const a of lines) {
    for (const b of others) {
      if (a === b) continue;
      const pairKey = [a.lineId ?? a.genericId, b.lineId ?? b.genericId].sort().join('~');
      if (dupSeen.has(pairKey)) continue;
      const sameInn = componentsOf(a.inn).some((c) => componentsOf(b.inn).includes(c));
      const sameClass = !sameInn && !!a.therapeuticClass && !!b.therapeuticClass && norm(a.therapeuticClass) === norm(b.therapeuticClass);
      if (!sameInn && !sameClass) continue;
      dupSeen.add(pairKey);
      out.push({
        type: ClinicalAlertType.DUPLICATE_THERAPY,
        severity: sameInn ? InteractionSeverity.MODERATE : InteractionSeverity.MINOR,
        message: sameInn
          ? `${a.label} duplicates ${b.label}${b.lineId ? '' : ' (active medication)'} — same substance`
          : `${a.label} and ${b.label}${b.lineId ? '' : ' (active medication)'} are both ${a.therapeuticClass}`,
        management: 'Confirm both are intended (e.g. a dose change rather than a second course).',
        lineIds: ids(a, b),
        fingerprint: fp('DUPLICATE_THERAPY', [sameInn ? norm(a.inn) : classTerm(a.therapeuticClass!)], [a, b]),
      });
    }
  }

  for (const l of lines) {
    if (l.minAgeYears !== null && patient.ageYears !== null && patient.ageYears < l.minAgeYears) {
      out.push({
        type: ClinicalAlertType.AGE,
        severity: InteractionSeverity.MAJOR,
        message: `${l.label} is not recommended under ${l.minAgeYears} years (patient is ${Math.floor(patient.ageYears * 10) / 10})`,
        management: 'Check the indication and dose with the prescriber.',
        lineIds: ids(l),
        fingerprint: fp('AGE', [norm(l.inn)], [l]),
      });
    }
    if (l.pregnancyContraindicated && patient.isPregnant) {
      out.push({
        type: ClinicalAlertType.PREGNANCY,
        severity: InteractionSeverity.CONTRAINDICATED,
        message: `${l.label} is contraindicated in pregnancy`,
        management: 'Do not dispense; ask the prescriber for an alternative.',
        lineIds: ids(l),
        fingerprint: fp('PREGNANCY', [norm(l.inn)], [l]),
      });
    }
  }
  return out.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

/** Age in years (fractional) on a date. */
export function ageInYears(dateOfBirth: string | null, today: string): number | null {
  if (!dateOfBirth) return null;
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dateOfBirth}T00:00:00Z`);
  return Math.max(0, ms / (365.25 * 86_400_000));
}

/** CSV import rows: inn_a, inn_b, severity, mechanism, management[, source]. */
export function parseInteractionCsv(text: string): { rows: (Omit<InteractionPair, 'source'> & { source?: string })[]; errors: string[] } {
  const rows: (Omit<InteractionPair, 'source'> & { source?: string })[] = [];
  const errors: string[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsv(lines[0] ?? '').map(norm);
  const col = (name: string) => header.indexOf(name);
  const need = ['inn_a', 'inn_b', 'severity', 'mechanism', 'management'];
  const missing = need.filter((n) => col(n) < 0);
  if (missing.length) return { rows: [], errors: [`Missing column(s): ${missing.join(', ')}`] };
  for (const [i, line] of lines.slice(1).entries()) {
    const c = splitCsv(line);
    const severity = (c[col('severity')] ?? '').trim().toUpperCase() as InteractionSeverity;
    if (!Object.values(InteractionSeverity).includes(severity)) {
      errors.push(`Row ${i + 2}: unknown severity "${c[col('severity')]}"`);
      continue;
    }
    const a = c[col('inn_a')]?.trim();
    const b = c[col('inn_b')]?.trim();
    if (!a || !b || norm(a) === norm(b)) {
      errors.push(`Row ${i + 2}: two different substances are needed`);
      continue;
    }
    const [innA, innB] = orderPair(a, b);
    rows.push({ innA, innB, severity, mechanism: (c[col('mechanism')] ?? '').trim().slice(0, 1000), management: (c[col('management')] ?? '').trim().slice(0, 1000), source: col('source') >= 0 ? c[col('source')]?.trim().toUpperCase() || undefined : undefined });
  }
  return { rows, errors };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
