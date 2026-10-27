import { MigrationInterface, QueryRunner } from "typeorm";

export class NonStockPhase61762700000000 implements MigrationInterface {
    name = 'NonStockPhase61762700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "system_setting" SET "value" = "value" || '{"accounting.autoSync": "*/15 * * * *"}'::jsonb WHERE "key" = 'jobs.schedules'`);
        await queryRunner.query(`ALTER TABLE "accounting_posting" ADD "sync_token" character varying(20)`);
        await queryRunner.query(`ALTER TABLE "accounting_posting" ADD "local_version" integer`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e85c493ba2e21da507a7b1756b"`);
        await queryRunner.query(`ALTER TYPE "public"."account_mapping_kind" RENAME TO "account_mapping_kind_old"`);
        await queryRunner.query(`CREATE TYPE "public"."account_mapping_kind" AS ENUM('CATEGORY_INVENTORY', 'CATEGORY_COGS', 'CATEGORY_INCOME', 'CATEGORY_CONSUMPTION', 'STORE_CLASS', 'DEPARTMENT_CLASS', 'TAX_CODE', 'PAYMENT_ACCOUNT', 'SYSTEM', 'GL_ACCOUNT')`);
        await queryRunner.query(`ALTER TABLE "account_mapping" ALTER COLUMN "kind" TYPE "public"."account_mapping_kind" USING "kind"::"text"::"public"."account_mapping_kind"`);
        await queryRunner.query(`DROP TYPE "public"."account_mapping_kind_old"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_febafa52bfa811241687767745"`);
        await queryRunner.query(`ALTER TYPE "public"."posting_doc_type" RENAME TO "posting_doc_type_old"`);
        await queryRunner.query(`CREATE TYPE "public"."posting_doc_type" AS ENUM('PURCHASE_ORDER', 'BILL', 'BILL_PAYMENT', 'VENDOR_CREDIT', 'SALES_RECEIPT', 'INVOICE', 'PAYMENT', 'REFUND_RECEIPT', 'CREDIT_MEMO', 'JOURNAL', 'PURCHASE', 'TRANSFER')`);
        await queryRunner.query(`ALTER TABLE "accounting_posting" ALTER COLUMN "doc_type" TYPE "public"."posting_doc_type" USING "doc_type"::"text"::"public"."posting_doc_type"`);
        await queryRunner.query(`DROP TYPE "public"."posting_doc_type_old"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e85c493ba2e21da507a7b1756b" ON "account_mapping" ("kind", "local_key") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_febafa52bfa811241687767745" ON "accounting_posting" ("doc_type", "local_doc_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "system_setting" SET "value" = "value" - 'accounting.autoSync' WHERE "key" = 'jobs.schedules'`);
        await queryRunner.query(`DROP INDEX "public"."IDX_febafa52bfa811241687767745"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e85c493ba2e21da507a7b1756b"`);
        await queryRunner.query(`CREATE TYPE "public"."posting_doc_type_old" AS ENUM('BILL', 'BILL_PAYMENT', 'VENDOR_CREDIT', 'SALES_RECEIPT', 'INVOICE', 'PAYMENT', 'REFUND_RECEIPT', 'CREDIT_MEMO', 'JOURNAL')`);
        await queryRunner.query(`ALTER TABLE "accounting_posting" ALTER COLUMN "doc_type" TYPE "public"."posting_doc_type_old" USING "doc_type"::"text"::"public"."posting_doc_type_old"`);
        await queryRunner.query(`DROP TYPE "public"."posting_doc_type"`);
        await queryRunner.query(`ALTER TYPE "public"."posting_doc_type_old" RENAME TO "posting_doc_type"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_febafa52bfa811241687767745" ON "accounting_posting" ("doc_type", "local_doc_id") `);
        await queryRunner.query(`CREATE TYPE "public"."account_mapping_kind_old" AS ENUM('CATEGORY_INVENTORY', 'CATEGORY_COGS', 'CATEGORY_INCOME', 'CATEGORY_CONSUMPTION', 'STORE_CLASS', 'DEPARTMENT_CLASS', 'TAX_CODE', 'PAYMENT_ACCOUNT', 'SYSTEM')`);
        await queryRunner.query(`ALTER TABLE "account_mapping" ALTER COLUMN "kind" TYPE "public"."account_mapping_kind_old" USING "kind"::"text"::"public"."account_mapping_kind_old"`);
        await queryRunner.query(`DROP TYPE "public"."account_mapping_kind"`);
        await queryRunner.query(`ALTER TYPE "public"."account_mapping_kind_old" RENAME TO "account_mapping_kind"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e85c493ba2e21da507a7b1756b" ON "account_mapping" ("kind", "local_key") `);
        await queryRunner.query(`ALTER TABLE "accounting_posting" DROP COLUMN "local_version"`);
        await queryRunner.query(`ALTER TABLE "accounting_posting" DROP COLUMN "sync_token"`);
    }

}
