import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { typeOrmOptions } from './typeorm-options';

/** Used by the TypeORM CLI (migration:run / migration:generate). */
export default new DataSource(typeOrmOptions());
