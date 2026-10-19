import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { loadEnv } from '../config/env';
import { AuditSubscriber } from '../modules/audit/audit.subscriber';
import { AuditLog } from '../modules/audit/audit-log.entity';
import { Generic, Item, ItemCategory, UnitConversion, UnitOfMeasure } from '../modules/catalog/catalog.entities';
import { DocumentSequence, NumberingScheme } from '../modules/numbering/numbering.entities';
import { Bin, Department, Facility, Store } from '../modules/org/org.entities';
import { Permission, Role } from '../modules/rbac/rbac.entities';
import { SystemSetting } from '../modules/settings/system-setting.entity';
import { TaxCategory, TaxRate } from '../modules/tax/tax.entities';
import { User } from '../modules/users/user.entity';
import { SnakeNamingStrategy } from './snake-naming.strategy';

export const ENTITIES = [
  AuditLog,
  SystemSetting,
  TaxCategory,
  TaxRate,
  NumberingScheme,
  DocumentSequence,
  Facility,
  Store,
  Bin,
  Department,
  Permission,
  Role,
  User,
  Generic,
  Item,
  ItemCategory,
  UnitOfMeasure,
  UnitConversion,
];

export function typeOrmOptions(overrides: Partial<DataSourceOptions> = {}): DataSourceOptions {
  const env = loadEnv();
  return {
    type: 'postgres',
    url: env.databaseUrl,
    entities: ENTITIES,
    subscribers: [AuditSubscriber],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'schema_migrations',
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    logging: env.dbLogging,
    extra: { max: 20, options: '-c timezone=UTC' },
    ...overrides,
  } as DataSourceOptions;
}
