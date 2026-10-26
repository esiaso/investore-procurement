import { MigrationInterface, QueryRunner } from "typeorm";

export class Accounting1762000000000 implements MigrationInterface {
    name = 'Accounting1762000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."accounting_provider" AS ENUM('QBO', 'MOCK')`);
        await queryRunner.query(`CREATE TYPE "public"."qbo_environment" AS ENUM('SANDBOX', 'PRODUCTION')`);
        await queryRunner.query(`CREATE TABLE "accounting_connection" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(40) NOT NULL, "provider" "public"."accounting_provider" NOT NULL, "environment" "public"."qbo_environment" NOT NULL DEFAULT 'SANDBOX', "client_id" character varying(100), "client_secret_enc" character varying(500), "redirect_uri" character varying(300), "realm_id" character varying(40), "company_name" character varying(200), "access_token_enc" character varying(4000), "access_expires_at" TIMESTAMP WITH TIME ZONE, "refresh_token_enc" character varying(1000), "refresh_expires_at" TIMESTAMP WITH TIME ZONE, "oauth_state" character varying(100), "connected_at" TIMESTAMP WITH TIME ZONE, "connected_by" uuid, "closing_date" date, "journals_from" date, "last_error" character varying(1000), "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_accounting_connection" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7f325ef3c133c452fcd226003e" ON "accounting_connection" ("code") `);
        await queryRunner.query(`CREATE TYPE "public"."account_mapping_kind" AS ENUM('CATEGORY_INVENTORY', 'CATEGORY_COGS', 'CATEGORY_INCOME', 'CATEGORY_CONSUMPTION', 'STORE_CLASS', 'DEPARTMENT_CLASS', 'TAX_CODE', 'PAYMENT_ACCOUNT', 'SYSTEM')`);
        await queryRunner.query(`CREATE TABLE "account_mapping" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "kind" "public"."account_mapping_kind" NOT NULL, "local_key" character varying(60) NOT NULL, "external_id" character varying(40) NOT NULL, "external_name" character varying(200), CONSTRAINT "pk_account_mapping" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e85c493ba2e21da507a7b1756b" ON "account_mapping" ("kind", "local_key") `);
        await queryRunner.query(`CREATE TYPE "public"."external_entity" AS ENUM('VENDOR', 'CUSTOMER', 'ITEM')`);
        await queryRunner.query(`CREATE TABLE "accounting_external_ref" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "entity" "public"."external_entity" NOT NULL, "local_key" character varying(100) NOT NULL, "external_id" character varying(40) NOT NULL, "display_name" character varying(200) NOT NULL, "synced_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_accounting_external_ref" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b50ff6a8c50816dcee4a6a1c41" ON "accounting_external_ref" ("entity", "local_key") `);
        await queryRunner.query(`CREATE TYPE "public"."posting_doc_type" AS ENUM('BILL', 'BILL_PAYMENT', 'VENDOR_CREDIT', 'SALES_RECEIPT', 'INVOICE', 'PAYMENT', 'REFUND_RECEIPT', 'CREDIT_MEMO', 'JOURNAL')`);
        await queryRunner.query(`CREATE TYPE "public"."posting_status" AS ENUM('READY', 'BLOCKED', 'PENDING', 'POSTED', 'FAILED')`);
        await queryRunner.query(`CREATE TABLE "accounting_posting" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "doc_type" "public"."posting_doc_type" NOT NULL, "local_doc_type" character varying(30) NOT NULL, "local_doc_id" character varying(60) NOT NULL, "local_doc_no" character varying(60), "txn_date" date NOT NULL, "amount" numeric(18,4) NOT NULL, "status" "public"."posting_status" NOT NULL, "batch_id" uuid, "entries" jsonb NOT NULL DEFAULT '[]'::jsonb, "payload" jsonb NOT NULL, "response" jsonb, "external_id" character varying(40), "error" character varying(1000), "attempts" integer NOT NULL DEFAULT '0', "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "posted_at" TIMESTAMP WITH TIME ZONE, "posted_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_accounting_posting" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d26c4af0121c3f41c07ab3c1e2" ON "accounting_posting" ("txn_date") `);
        await queryRunner.query(`CREATE INDEX "IDX_a8ff478872a580d902898f99db" ON "accounting_posting" ("status", "next_attempt_at") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_febafa52bfa811241687767745" ON "accounting_posting" ("doc_type", "local_doc_id") `);
        await queryRunner.query(`CREATE TABLE "accounting_batch" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "from_date" date NOT NULL, "to_date" date NOT NULL, "kinds" character varying(200) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'PREVIEW', "posted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_accounting_batch" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_69b21244f26a74d756979d576a" ON "accounting_batch" ("number") `);
        await queryRunner.query(`CREATE TABLE "payer_settlement" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "payer_id" uuid NOT NULL, "received_on" date NOT NULL, "amount" numeric(18,4) NOT NULL, "mode_code" character varying(20) NOT NULL, "reference" character varying(100) NOT NULL, "allocations" jsonb NOT NULL, "notes" character varying(500), CONSTRAINT "pk_payer_settlement" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_68284c34e1856b453a2efab22c" ON "payer_settlement" ("number") `);
        await queryRunner.query(`ALTER TABLE "customer_ledger" ADD "mode_code" character varying(20)`);
        await queryRunner.query(`UPDATE system_setting SET value = value || '{"accounting.dispatch": "*/5 * * * *", "accounting.refresh": "15 * * * *"}'::jsonb WHERE key = 'jobs.schedules'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE system_setting SET value = value - 'accounting.dispatch' - 'accounting.refresh' WHERE key = 'jobs.schedules'`);
        await queryRunner.query(`ALTER TABLE "customer_ledger" DROP COLUMN "mode_code"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_68284c34e1856b453a2efab22c"`);
        await queryRunner.query(`DROP TABLE "payer_settlement"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_69b21244f26a74d756979d576a"`);
        await queryRunner.query(`DROP TABLE "accounting_batch"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_febafa52bfa811241687767745"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a8ff478872a580d902898f99db"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d26c4af0121c3f41c07ab3c1e2"`);
        await queryRunner.query(`DROP TABLE "accounting_posting"`);
        await queryRunner.query(`DROP TYPE "public"."posting_status"`);
        await queryRunner.query(`DROP TYPE "public"."posting_doc_type"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b50ff6a8c50816dcee4a6a1c41"`);
        await queryRunner.query(`DROP TABLE "accounting_external_ref"`);
        await queryRunner.query(`DROP TYPE "public"."external_entity"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e85c493ba2e21da507a7b1756b"`);
        await queryRunner.query(`DROP TABLE "account_mapping"`);
        await queryRunner.query(`DROP TYPE "public"."account_mapping_kind"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7f325ef3c133c452fcd226003e"`);
        await queryRunner.query(`DROP TABLE "accounting_connection"`);
        await queryRunner.query(`DROP TYPE "public"."qbo_environment"`);
        await queryRunner.query(`DROP TYPE "public"."accounting_provider"`);
    }

}
