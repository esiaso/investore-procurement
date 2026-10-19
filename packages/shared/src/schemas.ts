import { z } from 'zod';
import {
  AttributeType,
  ControlledSchedule,
  SalesClass,
  ServicePoint,
  StoreType,
  TaxTreatment,
} from './enums';

const code = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(40)
  .regex(/^[A-Za-z0-9._/-]+$/, 'Letters, digits and . _ / - only');
const name = z.string().trim().min(1, 'Required').max(200);
const optText = (max = 500) => z.string().trim().max(max).nullish();
const uuid = z.string().uuid();

// ---------------------------------------------------------------- auth

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(100),
  password: z.string().min(1, 'Password is required').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const totpCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type TotpCodeInput = z.infer<typeof totpCodeSchema>;

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

/** Returns the list of policy violations for a candidate password (empty = ok). */
export function checkPassword(password: string, policy: PasswordPolicy, username?: string): string[] {
  const errors: string[] = [];
  if (password.length < policy.minLength) errors.push(`At least ${policy.minLength} characters`);
  if (policy.requireUppercase && !/[A-Z]/.test(password)) errors.push('At least one uppercase letter');
  if (policy.requireLowercase && !/[a-z]/.test(password)) errors.push('At least one lowercase letter');
  if (policy.requireDigit && !/\d/.test(password)) errors.push('At least one digit');
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) errors.push('At least one symbol');
  if (username && username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) {
    errors.push('Must not contain the username');
  }
  return errors;
}

export function passwordSchema(policy: PasswordPolicy, username?: string) {
  return z
    .string()
    .max(200)
    .superRefine((value, ctx) => {
      for (const message of checkPassword(value, policy, username)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      }
    });
}

// ---------------------------------------------------------------- org

export const facilitySchema = z.object({
  code,
  name,
  address: optText(),
  phone: optText(40),
  email: z.string().trim().email().max(200).nullish().or(z.literal('')),
  kraPin: optText(20),
  isActive: z.boolean().default(true),
});
export type FacilityInput = z.infer<typeof facilitySchema>;

export const storeSchema = z.object({
  facilityId: uuid,
  code,
  name,
  type: z.nativeEnum(StoreType),
  servicePoint: z.nativeEnum(ServicePoint).nullish(),
  parentStoreId: uuid.nullish(),
  isActive: z.boolean().default(true),
});
export type StoreInput = z.infer<typeof storeSchema>;

export const binSchema = z.object({
  storeId: uuid,
  code,
  name,
  zone: optText(100),
  isActive: z.boolean().default(true),
});
export type BinInput = z.infer<typeof binSchema>;

export const departmentSchema = z.object({
  facilityId: uuid,
  code,
  name,
  costCentreCode: code,
  isActive: z.boolean().default(true),
});
export type DepartmentInput = z.infer<typeof departmentSchema>;

// ---------------------------------------------------------------- users & roles

export const userBaseSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9._-]+$/, 'Lowercase letters, digits and . _ - only'),
  fullName: name,
  email: z.string().trim().email().max(200).nullish().or(z.literal('')),
  phone: optText(40),
  isActive: z.boolean().default(true),
  roleIds: z.array(uuid).min(1, 'Select at least one role'),
  storeIds: z.array(uuid).default([]),
  departmentId: uuid.nullish(),
});
export type UserInput = z.infer<typeof userBaseSchema>;

export const roleSchema = z.object({
  code: code.transform((v) => v.toUpperCase()),
  name,
  description: optText(),
  permissionCodes: z.array(z.string()).default([]),
});
export type RoleInput = z.infer<typeof roleSchema>;

// ---------------------------------------------------------------- tax & numbering

export const taxCategorySchema = z.object({
  code,
  name,
  treatment: z.nativeEnum(TaxTreatment),
  isActive: z.boolean().default(true),
});

export const taxRateSchema = z.object({
  taxCategoryId: uuid,
  ratePercent: z.number().min(0).max(100),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
});

// ---------------------------------------------------------------- catalog

export const genericSchema = z.object({
  innName: name,
  strength: optText(100),
  dosageForm: optText(100),
  route: optText(60),
  atcCode: z
    .string()
    .trim()
    .regex(/^[A-Z]\d{2}([A-Z]([A-Z](\d{2})?)?)?$/, 'Invalid ATC code (e.g. N02BE01)')
    .nullish()
    .or(z.literal('')),
  therapeuticClass: optText(200),
  isKeml: z.boolean().default(false),
  controlledSchedule: z.nativeEnum(ControlledSchedule).default(ControlledSchedule.NONE),
  storageRequirements: optText(),
  pregnancyNotes: optText(2000),
  lactationNotes: optText(2000),
  isActive: z.boolean().default(true),
});
export type GenericInput = z.infer<typeof genericSchema>;

export const attributeDefinitionSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-zA-Z0-9_]*$/, 'camelCase key'),
  label: name,
  type: z.nativeEnum(AttributeType),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
});
export type AttributeDefinition = z.infer<typeof attributeDefinitionSchema>;

export const itemCategorySchema = z.object({
  code,
  name,
  parentId: uuid.nullish(),
  isDrug: z.boolean().default(false),
  attributeSchema: z.array(attributeDefinitionSchema).default([]),
});
export type ItemCategoryInput = z.infer<typeof itemCategorySchema>;

export const uomSchema = z.object({
  code,
  name,
  isActive: z.boolean().default(true),
});

/** Quantities are NUMERIC(18,4); keep 4 decimals. */
const quantity = z.number().positive().max(1e14);

export const unitConversionSchema = z.object({
  itemId: uuid.nullish(),
  fromUomId: uuid,
  toUomId: uuid,
  factor: quantity,
});
export type UnitConversionInput = z.infer<typeof unitConversionSchema>;

export const gtinSchema = z
  .string()
  .trim()
  .regex(/^(\d{8}|\d{12}|\d{13}|\d{14})$/, 'GTIN must be 8, 12, 13 or 14 digits')
  .refine(isValidGtin, 'GTIN check digit is invalid');

export function isValidGtin(gtin: string): boolean {
  if (!/^\d+$/.test(gtin)) return false;
  const digits = gtin.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits
    .reverse()
    .reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export const itemSchema = z.object({
  code: code.nullish().or(z.literal('')),
  genericId: uuid.nullish(),
  categoryId: uuid,
  name,
  brandName: optText(200),
  manufacturer: optText(200),
  ppbRegNo: optText(60),
  packSize: optText(60),
  gtin: gtinSchema.nullish().or(z.literal('')),
  barcode: optText(60),
  baseUomId: uuid,
  unitPrice: z.number().min(0).max(1e12),
  salesClass: z.nativeEnum(SalesClass).nullish(),
  taxCategoryId: uuid,
  isFormulary: z.boolean().default(false),
  isBatchTracked: z.boolean().default(true),
  isColdChain: z.boolean().default(false),
  isControlled: z.boolean().default(false),
  reorderLevel: z.number().min(0).nullish(),
  attributes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  isActive: z.boolean().default(true),
});
export type ItemInput = z.infer<typeof itemSchema>;

/**
 * Validates a category's dynamic attribute values against its schema.
 * Returns a map of attribute key -> error message.
 */
export function validateAttributes(
  defs: AttributeDefinition[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const known = new Set(defs.map((d) => d.key));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) errors[key] = 'Unknown attribute for this category';
  }
  for (const def of defs) {
    const v = values[def.key];
    if (v === undefined || v === null || v === '') {
      if (def.required) errors[def.key] = `${def.label} is required`;
      continue;
    }
    switch (def.type) {
      case AttributeType.NUMBER:
        if (typeof v !== 'number' || Number.isNaN(v)) errors[def.key] = `${def.label} must be a number`;
        break;
      case AttributeType.BOOLEAN:
        if (typeof v !== 'boolean') errors[def.key] = `${def.label} must be true/false`;
        break;
      case AttributeType.ENUM:
        if (typeof v !== 'string' || !(def.options ?? []).includes(v)) {
          errors[def.key] = `${def.label} must be one of: ${(def.options ?? []).join(', ')}`;
        }
        break;
      default:
        if (typeof v !== 'string') errors[def.key] = `${def.label} must be text`;
    }
  }
  return errors;
}

// ---------------------------------------------------------------- import

/** Columns accepted by the item bulk import (CSV header / first Excel row). */
export const ITEM_IMPORT_COLUMNS = [
  'code',
  'name',
  'category_code',
  'generic_inn',
  'generic_strength',
  'generic_dosage_form',
  'generic_route',
  'atc_code',
  'keml',
  'brand_name',
  'manufacturer',
  'ppb_reg_no',
  'pack_size',
  'gtin',
  'base_uom',
  'unit_price',
  'sales_class',
  'tax_category',
  'formulary',
  'batch_tracked',
  'cold_chain',
  'controlled',
] as const;

export type ItemImportColumn = (typeof ITEM_IMPORT_COLUMNS)[number];

const yesNo = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === '') return undefined;
    if (typeof v === 'boolean') return v;
    const s = v.trim().toLowerCase();
    if (['y', 'yes', 'true', '1'].includes(s)) return true;
    if (['n', 'no', 'false', '0'].includes(s)) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use Y/N' });
    return z.NEVER;
  });

const blankToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const itemImportRowSchema = z.object({
  code: z.preprocess(blankToUndef, code.optional()),
  name,
  category_code: code,
  generic_inn: z.preprocess(blankToUndef, z.string().trim().max(200).optional()),
  generic_strength: z.preprocess(blankToUndef, z.string().trim().max(100).optional()),
  generic_dosage_form: z.preprocess(blankToUndef, z.string().trim().max(100).optional()),
  generic_route: z.preprocess(blankToUndef, z.string().trim().max(60).optional()),
  atc_code: z.preprocess(blankToUndef, genericSchema.shape.atcCode.optional()),
  keml: yesNo,
  brand_name: z.preprocess(blankToUndef, z.string().trim().max(200).optional()),
  manufacturer: z.preprocess(blankToUndef, z.string().trim().max(200).optional()),
  ppb_reg_no: z.preprocess(blankToUndef, z.string().trim().max(60).optional()),
  pack_size: z.preprocess(blankToUndef, z.string().trim().max(60).optional()),
  gtin: z.preprocess((v) => blankToUndef(typeof v === 'number' ? String(v) : v), gtinSchema.optional()),
  base_uom: code,
  unit_price: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/,/g, '')) : v),
    z.number({ invalid_type_error: 'Must be a number' }).min(0),
  ),
  sales_class: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim().toUpperCase()) : v),
    z.nativeEnum(SalesClass).optional(),
  ),
  tax_category: code,
  formulary: yesNo,
  batch_tracked: yesNo,
  cold_chain: yesNo,
  controlled: yesNo,
});
export type ItemImportRow = z.infer<typeof itemImportRowSchema>;
