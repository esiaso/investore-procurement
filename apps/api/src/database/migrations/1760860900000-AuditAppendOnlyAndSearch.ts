import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * - Makes audit_log append-only at the database level (UPDATE, DELETE and
 *   TRUNCATE raise an error regardless of the application).
 * - Trigram indexes for the catalog's "contains" searches.
 */
export class AuditAppendOnlyAndSearch1760860900000 implements MigrationInterface {
  name = 'AuditAppendOnlyAndSearch1760860900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only (% not allowed)', TG_OP USING ERRCODE = 'insufficient_privilege';
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`
      CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()`);
    await queryRunner.query(`
      CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable()`);

    await queryRunner.query(`CREATE INDEX "ix_item_name_trgm" ON "item" USING gin ("name" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX "ix_item_brand_trgm" ON "item" USING gin ("brand_name" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX "ix_generic_inn_trgm" ON "generic" USING gin ("inn_name" gin_trgm_ops)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "ix_generic_inn_trgm"`);
    await queryRunner.query(`DROP INDEX "ix_item_brand_trgm"`);
    await queryRunner.query(`DROP INDEX "ix_item_name_trgm"`);
    await queryRunner.query(`DROP TRIGGER audit_log_no_truncate ON audit_log`);
    await queryRunner.query(`DROP TRIGGER audit_log_no_update_delete ON audit_log`);
    await queryRunner.query(`DROP FUNCTION audit_log_immutable()`);
  }
}
