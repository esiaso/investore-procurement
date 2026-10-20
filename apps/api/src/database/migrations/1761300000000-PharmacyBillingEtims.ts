import { MigrationInterface, QueryRunner } from "typeorm";

export class PharmacyBillingEtims1761300000000 implements MigrationInterface {
    name = 'PharmacyBillingEtims1761300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Hand-edited: generator noise removed (stock_balance constraint/index, jsonb
        // defaults, notification_preference index); enums extended with ADD VALUE.
        await queryRunner.query(`ALTER TYPE "public"."stock_txn_type" ADD VALUE IF NOT EXISTS 'DISPENSE'`);
        await queryRunner.query(`ALTER TYPE "public"."stock_txn_type" ADD VALUE IF NOT EXISTS 'DISPENSE_RETURN'`);
        await queryRunner.query(`ALTER TYPE "public"."notification_category" ADD VALUE IF NOT EXISTS 'ETIMS'`);
        await queryRunner.query(`ALTER TYPE "public"."etims_status" ADD VALUE IF NOT EXISTS 'NOT_ON_ETIMS'`);
        await queryRunner.query(`CREATE TYPE "public"."price_list_type" AS ENUM('RETAIL', 'STAFF', 'CORPORATE', 'INSURANCE')`);
        await queryRunner.query(`CREATE TABLE "price_list" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(40) NOT NULL, "name" character varying(200) NOT NULL, "type" "public"."price_list_type" NOT NULL, "adjust_percent" numeric(7,4) NOT NULL DEFAULT '0', "is_default" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_price_list" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a185a5999456c0665e585aef49" ON "price_list" ("code") `);
        await queryRunner.query(`CREATE TABLE "price_list_item" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "price_list_id" uuid NOT NULL, "item_id" uuid NOT NULL, "price" numeric(18,4) NOT NULL, CONSTRAINT "pk_price_list_item" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_029da990133c1e5a641e72e44f" ON "price_list_item" ("price_list_id", "item_id") `);
        await queryRunner.query(`CREATE TYPE "public"."payer_type" AS ENUM('INSURANCE', 'CORPORATE')`);
        await queryRunner.query(`CREATE TABLE "payer" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(40) NOT NULL, "name" character varying(200) NOT NULL, "type" "public"."payer_type" NOT NULL, "kra_pin" character varying(11), "price_list_id" uuid, "co_pay_percent" numeric(7,4) NOT NULL DEFAULT '0', "etims_insurance_code" character varying(10), "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_payer" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c1f83f8dfb997aed9a9b47699f" ON "payer" ("code") `);
        await queryRunner.query(`CREATE TABLE "payment_mode" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(20) NOT NULL, "name" character varying(100) NOT NULL, "etims_payment_type_code" character varying(5) NOT NULL, "requires_reference" boolean NOT NULL DEFAULT false, "is_credit" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_payment_mode" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_16cc5d3816c7f6b0c6ca5f0819" ON "payment_mode" ("code") `);
        await queryRunner.query(`CREATE TYPE "public"."sales_doc_type" AS ENUM('INVOICE', 'CREDIT_NOTE')`);
        await queryRunner.query(`CREATE TYPE "public"."sales_invoice_status" AS ENUM('ISSUED', 'CANCELLED')`);
        await queryRunner.query(`CREATE TYPE "public"."sales_source" AS ENUM('DISPENSE', 'OTC', 'CONSUMABLE', 'HMIS', 'RETURN')`);
        await queryRunner.query(`CREATE TYPE "public"."etims_sync_status" AS ENUM('NOT_REQUIRED', 'PENDING', 'SENT', 'ACCEPTED', 'FAILED')`);
        await queryRunner.query(`CREATE TABLE "sales_invoice" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "doc_type" "public"."sales_doc_type" NOT NULL DEFAULT 'INVOICE', "original_invoice_id" uuid, "credit_reason_code" character varying(5), "status" "public"."sales_invoice_status" NOT NULL DEFAULT 'ISSUED', "source" "public"."sales_source" NOT NULL, "source_id" uuid, "external_ref" character varying(100), "store_id" uuid NOT NULL, "patient_id" uuid, "customer_name" character varying(200), "customer_pin" character varying(11), "customer_phone" character varying(20), "payer_id" uuid, "price_list_id" uuid, "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tax_summary" jsonb NOT NULL DEFAULT '{}'::jsonb, "total_net" numeric(18,4) NOT NULL DEFAULT '0', "total_tax" numeric(18,4) NOT NULL DEFAULT '0', "total_amount" numeric(18,4) NOT NULL DEFAULT '0', "discount_amount" numeric(18,4) NOT NULL DEFAULT '0', "payer_amount" numeric(18,4) NOT NULL DEFAULT '0', "patient_amount" numeric(18,4) NOT NULL DEFAULT '0', "paid_amount" numeric(18,4) NOT NULL DEFAULT '0', "etims_status" "public"."etims_sync_status" NOT NULL DEFAULT 'PENDING', "etims_invoice_no" bigint, "cu_invoice_no" character varying(60), "cu_id" character varying(40), "rcpt_no" integer, "tot_rcpt_no" integer, "intrl_data" character varying(64), "rcpt_sign" character varying(64), "sdc_date_time" character varying(14), "etims_error" character varying(1000), "etims_accepted_at" TIMESTAMP WITH TIME ZONE, "notes" character varying(1000), CONSTRAINT "pk_sales_invoice" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3f1da02a3f6f2c6bc753f85901" ON "sales_invoice" ("number") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5a9136cf95268a1581982d076c" ON "sales_invoice" ("external_ref") WHERE "external_ref" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_96fe72ba8aff432dea522603b5" ON "sales_invoice" ("source", "source_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_2e909966eb4ce977ed2e130ffe" ON "sales_invoice" ("etims_status") `);
        await queryRunner.query(`CREATE INDEX "IDX_7788c49b8fb7c1328518c53619" ON "sales_invoice" ("store_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "sales_invoice_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "invoice_id" uuid NOT NULL, "line_no" integer NOT NULL, "item_id" uuid NOT NULL, "description" character varying(200) NOT NULL, "quantity" numeric(18,4) NOT NULL, "unit_price" numeric(18,4) NOT NULL, "discount_percent" numeric(7,4) NOT NULL DEFAULT '0', "discount_amount" numeric(18,4) NOT NULL DEFAULT '0', "tax_category_id" uuid NOT NULL, "tax_type_code" character varying(5) NOT NULL, "tax_rate_percent" numeric(7,4) NOT NULL, "gross_amount" numeric(18,4) NOT NULL, "tax_amount" numeric(18,4) NOT NULL, "net_amount" numeric(18,4) NOT NULL, "payer_share" numeric(18,4) NOT NULL DEFAULT '0', "patient_share" numeric(18,4) NOT NULL DEFAULT '0', "original_line_id" uuid, "source_line_id" uuid, "allocations" jsonb NOT NULL DEFAULT '[]'::jsonb, CONSTRAINT "pk_sales_invoice_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_53337cb39e68e4a1cc14f23dbc" ON "sales_invoice_line" ("invoice_id") `);
        await queryRunner.query(`CREATE TABLE "sales_payment" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "invoice_id" uuid NOT NULL, "mode_code" character varying(20) NOT NULL, "etims_payment_type_code" character varying(5) NOT NULL, "amount" numeric(18,4) NOT NULL, "reference" character varying(100), "payer_id" uuid, CONSTRAINT "pk_sales_payment" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_56f39aff515aacd67b9561f04b" ON "sales_payment" ("invoice_id") `);
        await queryRunner.query(`CREATE TYPE "public"."etims_adapter_kind" AS ENUM('OSCU', 'VSCU', 'MOCK')`);
        await queryRunner.query(`CREATE TABLE "etims_config" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "store_id" uuid NOT NULL, "adapter" "public"."etims_adapter_kind" NOT NULL, "base_url" character varying(300), "kra_pin" character varying(11) NOT NULL, "branch_id" character varying(2) NOT NULL DEFAULT '00', "device_serial" character varying(100) NOT NULL, "cmc_key_enc" character varying(600), "cu_id" character varying(40), "mrc_no" character varying(20), "initialised_at" TIMESTAMP WITH TIME ZONE, "next_invoice_no" bigint NOT NULL DEFAULT '1', "next_sar_no" bigint NOT NULL DEFAULT '1', "next_item_seq" bigint NOT NULL DEFAULT '1', "next_purchase_no" bigint NOT NULL DEFAULT '1', "stock_report_error" character varying(500), "last_request" jsonb NOT NULL DEFAULT '{}'::jsonb, "last_stock_txn_id" bigint NOT NULL DEFAULT '0', "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_etims_config" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_cea09797dde893a71fb51bb151" ON "etims_config" ("store_id") `);
        await queryRunner.query(`CREATE TABLE "etims_code" ("cd_cls" character varying(2) NOT NULL, "cd" character varying(10) NOT NULL, "cd_nm" character varying(200) NOT NULL, "cd_cls_nm" character varying(60), "user_dfn_cd1" character varying(20), "use_yn" boolean NOT NULL DEFAULT true, "synced_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_etims_code" PRIMARY KEY ("cd_cls", "cd"))`);
        await queryRunner.query(`CREATE TABLE "etims_item_class" ("item_cls_cd" character varying(10) NOT NULL, "item_cls_nm" character varying(300) NOT NULL, "item_cls_lvl" integer, "tax_ty_cd" character varying(5), "use_yn" boolean NOT NULL DEFAULT true, "synced_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_etims_item_class" PRIMARY KEY ("item_cls_cd"))`);
        await queryRunner.query(`CREATE TABLE "etims_code_mapping" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "kind" character varying(30) NOT NULL, "local_key" character varying(60) NOT NULL, "etims_code" character varying(20) NOT NULL, CONSTRAINT "pk_etims_code_mapping" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e2c2c3cacb862aa44ad4815e0c" ON "etims_code_mapping" ("kind", "local_key") `);
        await queryRunner.query(`CREATE TABLE "etims_item" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "config_id" uuid NOT NULL, "item_id" uuid NOT NULL, "item_cd" character varying(20) NOT NULL, "item_cls_cd" character varying(10) NOT NULL, "pkg_unit_cd" character varying(5) NOT NULL, "qty_unit_cd" character varying(5) NOT NULL, "tax_ty_cd" character varying(5) NOT NULL, "status" "public"."etims_sync_status" NOT NULL DEFAULT 'PENDING', CONSTRAINT "pk_etims_item" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_27561074948394713ff0957796" ON "etims_item" ("item_cd") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2313a9b67df853987c6a50e1c5" ON "etims_item" ("config_id", "item_id") `);
        await queryRunner.query(`CREATE TYPE "public"."etims_outbox_kind" AS ENUM('ITEM', 'SALE', 'STOCK_IO', 'STOCK_MASTER', 'PURCHASE', 'IMPORT_ITEM')`);
        await queryRunner.query(`CREATE TABLE "etims_outbox" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "config_id" uuid NOT NULL, "kind" "public"."etims_outbox_kind" NOT NULL, "idempotency_key" character varying(200) NOT NULL, "doc_type" character varying(30) NOT NULL, "doc_id" uuid, "doc_no" character varying(60), "payload" jsonb NOT NULL, "depends_on" uuid array NOT NULL DEFAULT '{}', "status" "public"."etims_sync_status" NOT NULL DEFAULT 'PENDING', "attempts" integer NOT NULL DEFAULT '0', "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "result_cd" character varying(10), "result_msg" character varying(1000), "response" jsonb, "alerted_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "accepted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_etims_outbox" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fd0711d89b80cf0648281a1254" ON "etims_outbox" ("idempotency_key") `);
        await queryRunner.query(`CREATE INDEX "IDX_b81e6678058acb471c209b5ca6" ON "etims_outbox" ("doc_type", "doc_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_51fe5cf0999ad3d054d6ef428e" ON "etims_outbox" ("status", "next_attempt_at") `);
        await queryRunner.query(`CREATE TABLE "etims_transmission" ("id" BIGSERIAL NOT NULL, "outbox_id" uuid, "config_id" uuid NOT NULL, "operation" character varying(40) NOT NULL, "url" character varying(400) NOT NULL, "request" jsonb NOT NULL, "response" jsonb, "http_status" integer, "result_cd" character varying(10), "error" character varying(1000), "duration_ms" integer NOT NULL, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_etims_transmission" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d92d66e03a309ac0363e345671" ON "etims_transmission" ("at") `);
        await queryRunner.query(`CREATE INDEX "IDX_9948f9bf1c38a14efc1cd9c452" ON "etims_transmission" ("outbox_id") `);
        await queryRunner.query(`CREATE TYPE "public"."etims_purchase_status" AS ENUM('RECEIVED', 'CONFIRMED', 'REJECTED')`);
        await queryRunner.query(`CREATE TABLE "etims_purchase" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "config_id" uuid NOT NULL, "spplr_tin" character varying(11) NOT NULL, "spplr_nm" character varying(200), "spplr_bhf_id" character varying(2), "spplr_invc_no" character varying(40) NOT NULL, "sales_dt" character varying(8), "tot_taxbl_amt" numeric(18,4) NOT NULL DEFAULT '0', "tot_tax_amt" numeric(18,4) NOT NULL DEFAULT '0', "tot_amt" numeric(18,4) NOT NULL DEFAULT '0', "tax_breakdown" jsonb NOT NULL DEFAULT '{}'::jsonb, "items" jsonb NOT NULL DEFAULT '[]'::jsonb, "status" "public"."etims_purchase_status" NOT NULL DEFAULT 'RECEIVED', "supplier_invoice_id" uuid, "decision_note" character varying(500), CONSTRAINT "pk_etims_purchase" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9b8120457ef3f015006f61a8c3" ON "etims_purchase" ("spplr_tin", "spplr_invc_no", "config_id") `);
        await queryRunner.query(`CREATE TABLE "etims_import_item" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "config_id" uuid NOT NULL, "task_cd" character varying(50) NOT NULL, "dcl_de" character varying(8), "item_seq" integer NOT NULL, "dcl_no" character varying(50), "hs_cd" character varying(20), "item_nm" character varying(300) NOT NULL, "raw" jsonb NOT NULL DEFAULT '{}'::jsonb, "impt_item_stts_cd" character varying(2) NOT NULL DEFAULT '2', "item_id" uuid, CONSTRAINT "pk_etims_import_item" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b066e1828014e67c4345ecd0b1" ON "etims_import_item" ("config_id", "task_cd", "item_seq") `);
        await queryRunner.query(`CREATE TABLE "api_client" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "name" character varying(60) NOT NULL, "key_prefix" character varying(8) NOT NULL, "key_hash" character varying(255) NOT NULL, "scopes" text array NOT NULL DEFAULT '{}', "user_id" uuid NOT NULL, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_api_client" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_79ce16dd0d57df7a1736aff052" ON "api_client" ("name") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1e3bafd69b1fc944ffa398db25" ON "api_client" ("key_prefix") `);
        await queryRunner.query(`CREATE TYPE "public"."sex" AS ENUM('F', 'M', 'OTHER')`);
        await queryRunner.query(`CREATE TABLE "patient" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "hospital_no" character varying(40) NOT NULL, "name" character varying(200) NOT NULL, "date_of_birth" date, "sex" "public"."sex", "weight_kg" numeric(6,2), "is_pregnant" boolean NOT NULL DEFAULT false, "payer_id" uuid, "member_no" character varying(60), "allergies" text array NOT NULL DEFAULT '{}', "phone" character varying(20), "kra_pin" character varying(11), CONSTRAINT "pk_patient" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6368557a61a7dbd7aaf505fca7" ON "patient" ("hospital_no") `);
        await queryRunner.query(`CREATE INDEX "IDX_054a6cba30d6f51a1cb1e96f38" ON "patient" ("name") `);
        await queryRunner.query(`CREATE TYPE "public"."prescription_status" AS ENUM('RECEIVED', 'VERIFIED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'CLOSED', 'CANCELLED')`);
        await queryRunner.query(`CREATE TABLE "prescription" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "patient_id" uuid NOT NULL, "store_id" uuid NOT NULL, "prescriber" character varying(200) NOT NULL, "prescriber_reg_no" character varying(60), "encounter_ref" character varying(100), "external_ref" character varying(100), "status" "public"."prescription_status" NOT NULL DEFAULT 'RECEIVED', "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "verified_at" TIMESTAMP WITH TIME ZONE, "verified_by" uuid, "first_dispensed_at" TIMESTAMP WITH TIME ZONE, "completed_at" TIMESTAMP WITH TIME ZONE, "notes" character varying(1000), CONSTRAINT "pk_prescription" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5d28a20e77a3bf0248fe22d457" ON "prescription" ("number") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_91e15276088b0c8c1b447a71a7" ON "prescription" ("external_ref") WHERE "external_ref" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_b5b0de11e942201024ee9f32be" ON "prescription" ("patient_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_a9838a5982707d65b59e525a7a" ON "prescription" ("store_id", "status") `);
        await queryRunner.query(`CREATE TABLE "prescription_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "prescription_id" uuid NOT NULL, "line_no" integer NOT NULL, "generic_id" uuid NOT NULL, "preferred_item_id" uuid, "dose" character varying(100) NOT NULL, "frequency" character varying(60) NOT NULL, "duration" character varying(60), "route" character varying(60), "quantity" numeric(18,4) NOT NULL, "dispensed_qty" numeric(18,4) NOT NULL DEFAULT '0', "cancelled_qty" numeric(18,4) NOT NULL DEFAULT '0', "instructions" character varying(500), CONSTRAINT "pk_prescription_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "dispense" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "prescription_id" uuid NOT NULL, "patient_id" uuid NOT NULL, "store_id" uuid NOT NULL, "dispensed_by" uuid NOT NULL, "dispensed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "witness_id" uuid, "invoice_id" uuid, "fefo_override_reason" character varying(500), CONSTRAINT "pk_dispense" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_63e9109d6dfd2cc4b21a5086a7" ON "dispense" ("number") `);
        await queryRunner.query(`CREATE INDEX "IDX_0e5c2b8ab8821e14a30632c451" ON "dispense" ("prescription_id") `);
        await queryRunner.query(`CREATE TABLE "dispense_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "dispense_id" uuid NOT NULL, "prescription_line_id" uuid NOT NULL, "item_id" uuid NOT NULL, "substituted" boolean NOT NULL DEFAULT false, "batch_id" uuid NOT NULL, "bin_id" uuid, "quantity" numeric(18,4) NOT NULL, "unit_cost" numeric(18,6) NOT NULL, "returned_qty" numeric(18,4) NOT NULL DEFAULT '0', CONSTRAINT "pk_dispense_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_263d0ac4f2b1a0332cc87e58ef" ON "dispense_line" ("batch_id") `);
        await queryRunner.query(`CREATE TYPE "public"."interaction_severity" AS ENUM('CONTRAINDICATED', 'MAJOR', 'MODERATE', 'MINOR')`);
        await queryRunner.query(`CREATE TABLE "drug_interaction" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "inn_a" character varying(200) NOT NULL, "inn_b" character varying(200) NOT NULL, "severity" "public"."interaction_severity" NOT NULL, "mechanism" character varying(1000) NOT NULL, "management" character varying(1000) NOT NULL, "source" character varying(20) NOT NULL DEFAULT 'LOCAL', "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_drug_interaction" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b5d5ac72fcb02a1dfdce8ac5ab" ON "drug_interaction" ("inn_a", "inn_b") `);
        await queryRunner.query(`CREATE TYPE "public"."clinical_alert_type" AS ENUM('INTERACTION', 'ALLERGY', 'DUPLICATE_THERAPY', 'AGE', 'PREGNANCY')`);
        await queryRunner.query(`CREATE TABLE "clinical_alert" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "prescription_id" uuid NOT NULL, "patient_id" uuid NOT NULL, "type" "public"."clinical_alert_type" NOT NULL, "severity" "public"."interaction_severity" NOT NULL, "fingerprint" character varying(300) NOT NULL, "message" character varying(1000) NOT NULL, "management" character varying(1000), "line_ids" uuid array NOT NULL DEFAULT '{}', "blocking" boolean NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_clinical_alert" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6a4c39477d035d7d04e75ccb72" ON "clinical_alert" ("created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_c1b13cc31e783e800dc04c44f0" ON "clinical_alert" ("prescription_id") `);
        await queryRunner.query(`CREATE TABLE "interaction_override" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "alert_id" uuid NOT NULL, "prescription_id" uuid NOT NULL, "pharmacist_id" uuid NOT NULL, "reason" character varying(1000) NOT NULL, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_interaction_override" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4f28ca892999335fcb8275c868" ON "interaction_override" ("alert_id") `);
        await queryRunner.query(`ALTER TABLE "generic" ADD "pregnancy_contraindicated" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "generic" ADD "min_age_years" numeric(5,2)`);
        await queryRunner.query(`ALTER TABLE "price_list_item" ADD CONSTRAINT "FK_9f21c71d7a0c3512db0aac1d884" FOREIGN KEY ("price_list_id") REFERENCES "price_list"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "price_list_item" ADD CONSTRAINT "FK_d33f187e058b7f2c7e370d39b6d" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payer" ADD CONSTRAINT "FK_5e9182cce432ca72091e3f44715" FOREIGN KEY ("price_list_id") REFERENCES "price_list"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sales_invoice" ADD CONSTRAINT "FK_abc879a5af07e58c14ba1b82db3" FOREIGN KEY ("original_invoice_id") REFERENCES "sales_invoice"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sales_invoice" ADD CONSTRAINT "FK_e16159b10ce8c767c96faa54e61" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sales_invoice" ADD CONSTRAINT "FK_9c9421a8da46ce95fdb8301696f" FOREIGN KEY ("payer_id") REFERENCES "payer"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sales_invoice_line" ADD CONSTRAINT "FK_53337cb39e68e4a1cc14f23dbc8" FOREIGN KEY ("invoice_id") REFERENCES "sales_invoice"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sales_invoice_line" ADD CONSTRAINT "FK_114239bd32d4e02748ef60f5046" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sales_payment" ADD CONSTRAINT "FK_56f39aff515aacd67b9561f04b2" FOREIGN KEY ("invoice_id") REFERENCES "sales_invoice"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "etims_config" ADD CONSTRAINT "FK_cea09797dde893a71fb51bb151a" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "etims_item" ADD CONSTRAINT "FK_3c5ec523556c32b475057964d95" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "patient" ADD CONSTRAINT "FK_b82f250ef60d733d502bcf4eeea" FOREIGN KEY ("payer_id") REFERENCES "payer"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "prescription" ADD CONSTRAINT "FK_b5b0de11e942201024ee9f32be7" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "prescription" ADD CONSTRAINT "FK_64f05db3685dec21a63a3011689" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "prescription_line" ADD CONSTRAINT "FK_bf0b0afb0efe7d0f9fc070bdbff" FOREIGN KEY ("prescription_id") REFERENCES "prescription"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "prescription_line" ADD CONSTRAINT "FK_3509979411f128960d6b86f4840" FOREIGN KEY ("generic_id") REFERENCES "generic"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "dispense" ADD CONSTRAINT "FK_0e5c2b8ab8821e14a30632c4513" FOREIGN KEY ("prescription_id") REFERENCES "prescription"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "dispense_line" ADD CONSTRAINT "FK_102fcefea5bf57c0cf6d0255da2" FOREIGN KEY ("dispense_id") REFERENCES "dispense"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "dispense_line" ADD CONSTRAINT "FK_3bf4e2c4fbcf5ed46eac6d41219" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "dispense_line" ADD CONSTRAINT "FK_263d0ac4f2b1a0332cc87e58efc" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "interaction_override" ADD CONSTRAINT "FK_4f28ca892999335fcb8275c8687" FOREIGN KEY ("alert_id") REFERENCES "clinical_alert"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        // Issued sales documents are immutable: corrections are credit notes.
        // Only the eTIMS result columns may change, and not once eTIMS accepted it.
        await queryRunner.query(`
          CREATE FUNCTION sales_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
          DECLARE
            etims_cols text[] := ARRAY['etims_status','etims_invoice_no','cu_invoice_no','cu_id','rcpt_no','tot_rcpt_no','intrl_data',
                                       'rcpt_sign','sdc_date_time','etims_error','etims_accepted_at','updated_at','updated_by'];
          BEGIN
            IF TG_OP = 'DELETE' THEN
              RAISE EXCEPTION 'Sales invoice % cannot be deleted; issue a credit note', OLD.number USING ERRCODE = 'check_violation';
            END IF;
            IF (to_jsonb(NEW) - etims_cols) IS DISTINCT FROM (to_jsonb(OLD) - etims_cols) THEN
              RAISE EXCEPTION 'Sales invoice % is issued and cannot be changed; issue a credit note', OLD.number USING ERRCODE = 'check_violation';
            END IF;
            IF OLD.etims_status = 'ACCEPTED' AND (to_jsonb(NEW) - ARRAY['updated_at','updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at','updated_by']) THEN
              RAISE EXCEPTION 'Sales invoice % was accepted by eTIMS and is immutable', OLD.number USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
          END $$`);
        await queryRunner.query(`CREATE TRIGGER trg_sales_invoice_guard BEFORE UPDATE OR DELETE ON sales_invoice FOR EACH ROW EXECUTE FUNCTION sales_invoice_guard()`);
        await queryRunner.query(`
          CREATE FUNCTION sales_invoice_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION '% rows of an issued sales invoice cannot be changed or deleted', TG_TABLE_NAME USING ERRCODE = 'check_violation';
          END $$`);
        await queryRunner.query(`CREATE TRIGGER trg_sales_invoice_line_guard BEFORE UPDATE OR DELETE ON sales_invoice_line FOR EACH ROW EXECUTE FUNCTION sales_invoice_child_guard()`);
        await queryRunner.query(`CREATE TRIGGER trg_sales_payment_guard BEFORE UPDATE OR DELETE ON sales_payment FOR EACH ROW EXECUTE FUNCTION sales_invoice_child_guard()`);
        // Overrides are the audit record of a clinical decision.
        await queryRunner.query(`CREATE TRIGGER trg_interaction_override_guard BEFORE UPDATE OR DELETE ON interaction_override FOR EACH ROW EXECUTE FUNCTION sales_invoice_child_guard()`);

        // Existing installations: dispenses count as consumption; schedule the eTIMS jobs.
        await queryRunner.query(`UPDATE system_setting SET value = value || '["DISPENSE"]'::jsonb WHERE key = 'stock.amcTxnTypes' AND NOT value ? 'DISPENSE'`);
        await queryRunner.query(
            `UPDATE system_setting SET value = $1::jsonb || value WHERE key = 'jobs.schedules'`,
            [JSON.stringify({ 'etims.dispatch': '* * * * *', 'etims.stock': '*/15 * * * *', 'etims.purchases': '0 * * * *', 'etims.monitor': '*/15 * * * *', 'etims.codes': '0 3 * * *' })],
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE system_setting SET value = value - 'etims.dispatch' - 'etims.stock' - 'etims.purchases' - 'etims.monitor' - 'etims.codes' WHERE key = 'jobs.schedules'`);
        await queryRunner.query(`UPDATE system_setting SET value = value - 'DISPENSE' WHERE key = 'stock.amcTxnTypes'`);
        await queryRunner.query(`DROP TRIGGER trg_interaction_override_guard ON interaction_override`);
        await queryRunner.query(`DROP TRIGGER trg_sales_payment_guard ON sales_payment`);
        await queryRunner.query(`DROP TRIGGER trg_sales_invoice_line_guard ON sales_invoice_line`);
        await queryRunner.query(`DROP TRIGGER trg_sales_invoice_guard ON sales_invoice`);
        await queryRunner.query(`DROP FUNCTION sales_invoice_child_guard()`);
        await queryRunner.query(`DROP FUNCTION sales_invoice_guard()`);
        await queryRunner.query(`ALTER TABLE "interaction_override" DROP CONSTRAINT "FK_4f28ca892999335fcb8275c8687"`);
        await queryRunner.query(`ALTER TABLE "dispense_line" DROP CONSTRAINT "FK_263d0ac4f2b1a0332cc87e58efc"`);
        await queryRunner.query(`ALTER TABLE "dispense_line" DROP CONSTRAINT "FK_3bf4e2c4fbcf5ed46eac6d41219"`);
        await queryRunner.query(`ALTER TABLE "dispense_line" DROP CONSTRAINT "FK_102fcefea5bf57c0cf6d0255da2"`);
        await queryRunner.query(`ALTER TABLE "dispense" DROP CONSTRAINT "FK_0e5c2b8ab8821e14a30632c4513"`);
        await queryRunner.query(`ALTER TABLE "prescription_line" DROP CONSTRAINT "FK_3509979411f128960d6b86f4840"`);
        await queryRunner.query(`ALTER TABLE "prescription_line" DROP CONSTRAINT "FK_bf0b0afb0efe7d0f9fc070bdbff"`);
        await queryRunner.query(`ALTER TABLE "prescription" DROP CONSTRAINT "FK_64f05db3685dec21a63a3011689"`);
        await queryRunner.query(`ALTER TABLE "prescription" DROP CONSTRAINT "FK_b5b0de11e942201024ee9f32be7"`);
        await queryRunner.query(`ALTER TABLE "patient" DROP CONSTRAINT "FK_b82f250ef60d733d502bcf4eeea"`);
        await queryRunner.query(`ALTER TABLE "etims_item" DROP CONSTRAINT "FK_3c5ec523556c32b475057964d95"`);
        await queryRunner.query(`ALTER TABLE "etims_config" DROP CONSTRAINT "FK_cea09797dde893a71fb51bb151a"`);
        await queryRunner.query(`ALTER TABLE "sales_payment" DROP CONSTRAINT "FK_56f39aff515aacd67b9561f04b2"`);
        await queryRunner.query(`ALTER TABLE "sales_invoice_line" DROP CONSTRAINT "FK_114239bd32d4e02748ef60f5046"`);
        await queryRunner.query(`ALTER TABLE "sales_invoice_line" DROP CONSTRAINT "FK_53337cb39e68e4a1cc14f23dbc8"`);
        await queryRunner.query(`ALTER TABLE "sales_invoice" DROP CONSTRAINT "FK_9c9421a8da46ce95fdb8301696f"`);
        await queryRunner.query(`ALTER TABLE "sales_invoice" DROP CONSTRAINT "FK_e16159b10ce8c767c96faa54e61"`);
        await queryRunner.query(`ALTER TABLE "sales_invoice" DROP CONSTRAINT "FK_abc879a5af07e58c14ba1b82db3"`);
        await queryRunner.query(`ALTER TABLE "payer" DROP CONSTRAINT "FK_5e9182cce432ca72091e3f44715"`);
        await queryRunner.query(`ALTER TABLE "price_list_item" DROP CONSTRAINT "FK_d33f187e058b7f2c7e370d39b6d"`);
        await queryRunner.query(`ALTER TABLE "price_list_item" DROP CONSTRAINT "FK_9f21c71d7a0c3512db0aac1d884"`);
        // Enum values added in up() (DISPENSE, DISPENSE_RETURN, ETIMS, NOT_ON_ETIMS) are left in place:
        // PostgreSQL cannot drop enum values and they are harmless when unused.
        await queryRunner.query(`ALTER TABLE "generic" DROP COLUMN "min_age_years"`);
        await queryRunner.query(`ALTER TABLE "generic" DROP COLUMN "pregnancy_contraindicated"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4f28ca892999335fcb8275c868"`);
        await queryRunner.query(`DROP TABLE "interaction_override"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c1b13cc31e783e800dc04c44f0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6a4c39477d035d7d04e75ccb72"`);
        await queryRunner.query(`DROP TABLE "clinical_alert"`);
        await queryRunner.query(`DROP TYPE "public"."clinical_alert_type"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b5d5ac72fcb02a1dfdce8ac5ab"`);
        await queryRunner.query(`DROP TABLE "drug_interaction"`);
        await queryRunner.query(`DROP TYPE "public"."interaction_severity"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_263d0ac4f2b1a0332cc87e58ef"`);
        await queryRunner.query(`DROP TABLE "dispense_line"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0e5c2b8ab8821e14a30632c451"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_63e9109d6dfd2cc4b21a5086a7"`);
        await queryRunner.query(`DROP TABLE "dispense"`);
        await queryRunner.query(`DROP TABLE "prescription_line"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a9838a5982707d65b59e525a7a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b5b0de11e942201024ee9f32be"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_91e15276088b0c8c1b447a71a7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5d28a20e77a3bf0248fe22d457"`);
        await queryRunner.query(`DROP TABLE "prescription"`);
        await queryRunner.query(`DROP TYPE "public"."prescription_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_054a6cba30d6f51a1cb1e96f38"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6368557a61a7dbd7aaf505fca7"`);
        await queryRunner.query(`DROP TABLE "patient"`);
        await queryRunner.query(`DROP TYPE "public"."sex"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1e3bafd69b1fc944ffa398db25"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_79ce16dd0d57df7a1736aff052"`);
        await queryRunner.query(`DROP TABLE "api_client"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b066e1828014e67c4345ecd0b1"`);
        await queryRunner.query(`DROP TABLE "etims_import_item"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9b8120457ef3f015006f61a8c3"`);
        await queryRunner.query(`DROP TABLE "etims_purchase"`);
        await queryRunner.query(`DROP TYPE "public"."etims_purchase_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9948f9bf1c38a14efc1cd9c452"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d92d66e03a309ac0363e345671"`);
        await queryRunner.query(`DROP TABLE "etims_transmission"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_51fe5cf0999ad3d054d6ef428e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b81e6678058acb471c209b5ca6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fd0711d89b80cf0648281a1254"`);
        await queryRunner.query(`DROP TABLE "etims_outbox"`);
        await queryRunner.query(`DROP TYPE "public"."etims_outbox_kind"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2313a9b67df853987c6a50e1c5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_27561074948394713ff0957796"`);
        await queryRunner.query(`DROP TABLE "etims_item"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e2c2c3cacb862aa44ad4815e0c"`);
        await queryRunner.query(`DROP TABLE "etims_code_mapping"`);
        await queryRunner.query(`DROP TABLE "etims_item_class"`);
        await queryRunner.query(`DROP TABLE "etims_code"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cea09797dde893a71fb51bb151"`);
        await queryRunner.query(`DROP TABLE "etims_config"`);
        await queryRunner.query(`DROP TYPE "public"."etims_adapter_kind"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_56f39aff515aacd67b9561f04b"`);
        await queryRunner.query(`DROP TABLE "sales_payment"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_53337cb39e68e4a1cc14f23dbc"`);
        await queryRunner.query(`DROP TABLE "sales_invoice_line"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7788c49b8fb7c1328518c53619"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2e909966eb4ce977ed2e130ffe"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_96fe72ba8aff432dea522603b5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5a9136cf95268a1581982d076c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3f1da02a3f6f2c6bc753f85901"`);
        await queryRunner.query(`DROP TABLE "sales_invoice"`);
        await queryRunner.query(`DROP TYPE "public"."etims_sync_status"`);
        await queryRunner.query(`DROP TYPE "public"."sales_source"`);
        await queryRunner.query(`DROP TYPE "public"."sales_invoice_status"`);
        await queryRunner.query(`DROP TYPE "public"."sales_doc_type"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_16cc5d3816c7f6b0c6ca5f0819"`);
        await queryRunner.query(`DROP TABLE "payment_mode"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c1f83f8dfb997aed9a9b47699f"`);
        await queryRunner.query(`DROP TABLE "payer"`);
        await queryRunner.query(`DROP TYPE "public"."payer_type"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_029da990133c1e5a641e72e44f"`);
        await queryRunner.query(`DROP TABLE "price_list_item"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a185a5999456c0665e585aef49"`);
        await queryRunner.query(`DROP TABLE "price_list"`);
        await queryRunner.query(`DROP TYPE "public"."price_list_type"`);
    }

}
