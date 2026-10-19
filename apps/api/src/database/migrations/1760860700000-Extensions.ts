import { MigrationInterface, QueryRunner } from 'typeorm';

export class Extensions1760860700000 implements MigrationInterface {
  name = 'Extensions1760860700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
  }

  public async down(): Promise<void> {
    // Extensions may be shared with other schemas; leave them in place.
  }
}
