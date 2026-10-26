import { MigrationInterface, QueryRunner } from "typeorm";

export class Hmis1761700000000 implements MigrationInterface {
    name = 'Hmis1761700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."notification_category" ADD VALUE IF NOT EXISTS 'HMIS'`);
        await queryRunner.query(`CREATE TYPE "public"."hmis_adapter_kind" AS ENUM('FHIR', 'REST', 'MOCK')`);
        await queryRunner.query(`CREATE TYPE "public"."hmis_billing_mode" AS ENUM('LOCAL', 'HMIS')`);
        await queryRunner.query(`CREATE TABLE "hmis_connection" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(40) NOT NULL, "name" character varying(200) NOT NULL, "adapter" "public"."hmis_adapter_kind" NOT NULL, "base_url" character varying(300), "auth_token_enc" character varying(1000), "auth_header" character varying(60) NOT NULL DEFAULT 'Authorization', "hospital_no_system" character varying(200) NOT NULL DEFAULT 'urn:sil:hospital-no', "billing_mode" "public"."hmis_billing_mode" NOT NULL DEFAULT 'LOCAL', "send_dispenses" boolean NOT NULL DEFAULT true, "poll_orders" boolean NOT NULL DEFAULT true, "last_polled_at" TIMESTAMP WITH TIME ZONE, "last_poll_error" character varying(1000), "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_hmis_connection" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e35bf79bca13d15a4c2c967e7f" ON "hmis_connection" ("code") `);
        await queryRunner.query(`CREATE TYPE "public"."hmis_mapping_kind" AS ENUM('DRUG', 'LOCATION', 'WARD', 'PAYER')`);
        await queryRunner.query(`CREATE TABLE "hmis_code_mapping" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "kind" "public"."hmis_mapping_kind" NOT NULL, "external_code" character varying(100) NOT NULL, "external_display" character varying(300), "local_id" uuid NOT NULL, "is_item" boolean NOT NULL DEFAULT false, CONSTRAINT "pk_hmis_code_mapping" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e49617552b787ec3c38082f607" ON "hmis_code_mapping" ("kind", "external_code") `);
        await queryRunner.query(`CREATE TYPE "public"."encounter_class" AS ENUM('OPD', 'IPD', 'EMERGENCY', 'DAY_CASE')`);
        await queryRunner.query(`CREATE TYPE "public"."encounter_status" AS ENUM('ACTIVE', 'FINISHED', 'CANCELLED')`);
        await queryRunner.query(`CREATE TABLE "encounter" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "external_id" character varying(100) NOT NULL, "patient_id" uuid NOT NULL, "class" "public"."encounter_class" NOT NULL, "status" "public"."encounter_status" NOT NULL DEFAULT 'ACTIVE', "department_id" uuid, "ward_code" character varying(100), "bed" character varying(40), "payer_id" uuid, "member_no" character varying(60), "attending" character varying(200), "started_at" TIMESTAMP WITH TIME ZONE, "ended_at" TIMESTAMP WITH TIME ZONE, "synced_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_encounter" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5ffe98e1bba2764c805d7180dc" ON "encounter" ("external_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_3a8ec672aec46a16c0289889c6" ON "encounter" ("department_id", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_96cf9442d9d341953b29efa40f" ON "encounter" ("patient_id", "status") `);
        await queryRunner.query(`CREATE TYPE "public"."hmis_direction" AS ENUM('IN', 'OUT')`);
        await queryRunner.query(`CREATE TYPE "public"."hmis_message_type" AS ENUM('PATIENT', 'ENCOUNTER', 'ALLERGY', 'MEDICATION_REQUEST', 'MEDICATION_DISPENSE', 'CHARGE')`);
        await queryRunner.query(`CREATE TYPE "public"."hmis_message_status" AS ENUM('PENDING', 'PROCESSED', 'SENT', 'FAILED', 'IGNORED')`);
        await queryRunner.query(`CREATE TABLE "hmis_message" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "direction" "public"."hmis_direction" NOT NULL, "type" "public"."hmis_message_type" NOT NULL, "status" "public"."hmis_message_status" NOT NULL DEFAULT 'PENDING', "idempotency_key" character varying(300) NOT NULL, "external_id" character varying(100), "via" character varying(20), "local_doc_type" character varying(30), "local_doc_id" uuid, "local_doc_no" character varying(60), "patient_id" uuid, "encounter_id" uuid, "payload" jsonb NOT NULL, "request" jsonb, "response" jsonb, "http_status" integer, "attempts" integer NOT NULL DEFAULT '0', "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "error" character varying(1000), "duplicates" integer NOT NULL DEFAULT '0', "alerted_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "processed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_hmis_message" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9afb86463b8f200a77272d6bb2" ON "hmis_message" ("idempotency_key") `);
        await queryRunner.query(`CREATE INDEX "IDX_6a6a933aa9750b5305928ed6fa" ON "hmis_message" ("created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_2d45f1f98e30bd88da89dbc92c" ON "hmis_message" ("local_doc_type", "local_doc_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_11634e8ac2e1ed22cfa622d6d2" ON "hmis_message" ("status", "next_attempt_at") `);
        await queryRunner.query(`CREATE TYPE "public"."patient_charge_source" AS ENUM('DISPENSE', 'ISSUE', 'WARD_CONSUMPTION')`);
        await queryRunner.query(`CREATE TYPE "public"."patient_charge_status" AS ENUM('INVOICED', 'PENDING', 'POSTED', 'FAILED')`);
        await queryRunner.query(`CREATE TABLE "patient_charge" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "patient_id" uuid NOT NULL, "encounter_id" uuid, "source" "public"."patient_charge_source" NOT NULL, "source_id" uuid NOT NULL, "source_no" character varying(60), "source_line_id" uuid NOT NULL, "store_id" uuid, "department_id" uuid, "item_id" uuid NOT NULL, "description" character varying(200) NOT NULL, "quantity" numeric(18,4) NOT NULL, "unit_price" numeric(18,4) NOT NULL, "amount" numeric(18,4) NOT NULL, "status" "public"."patient_charge_status" NOT NULL, "invoice_id" uuid, "message_id" uuid, "external_id" character varying(100), "reverses_id" uuid, "note" character varying(500), CONSTRAINT "pk_patient_charge" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_19f893262d1840952c9217d81b" ON "patient_charge" ("source", "source_id", "source_line_id") WHERE "reverses_id" IS NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_c451f8f9ec0b021f96c8031552" ON "patient_charge" ("patient_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_c7c5a12e4eb64cdd681b7a245f" ON "patient_charge" ("encounter_id") `);
        await queryRunner.query(`ALTER TABLE "store_requisition_line" ADD "encounter_id" uuid`);
        await queryRunner.query(`ALTER TABLE "patient" ADD "external_id" character varying(100)`);
        await queryRunner.query(`ALTER TABLE "patient" ADD "synced_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "prescription" ADD "encounter_id" uuid`);
        await queryRunner.query(`CREATE TYPE "public"."supply_mode" AS ENUM('STANDARD', 'DAILY', 'UNIT_DOSE')`);
        await queryRunner.query(`ALTER TABLE "prescription" ADD "supply_mode" "public"."supply_mode" NOT NULL DEFAULT 'STANDARD'`);
        await queryRunner.query(`ALTER TABLE "prescription_line" ADD "external_ref" character varying(100)`);
        await queryRunner.query(`ALTER TABLE "prescription_line" ADD "hmis_drug_code" character varying(100)`);
        await queryRunner.query(`ALTER TABLE "prescription_line" ADD "daily_quantity" numeric(18,4)`);
        await queryRunner.query(`ALTER TABLE "dispense" ADD "billing_mode" "public"."hmis_billing_mode" NOT NULL DEFAULT 'LOCAL'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_be9fe9bf74a32013e0d81a5c98" ON "patient" ("external_id") WHERE "external_id" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_913fab5a18f6e6fd6447c31ccd" ON "prescription" ("encounter_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1357fddc448d9157b48ff718c1" ON "prescription_line" ("external_ref") WHERE "external_ref" IS NOT NULL`);
        await queryRunner.query(`ALTER TABLE "prescription" ADD CONSTRAINT "FK_913fab5a18f6e6fd6447c31ccd9" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "encounter" ADD CONSTRAINT "FK_229e2fb2c0e5101c3a9e7921367" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "encounter" ADD CONSTRAINT "FK_4ac21babaf89a17c455162d87ce" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "encounter" ADD CONSTRAINT "FK_0d26fd103fc226cf7e1707ff09b" FOREIGN KEY ("payer_id") REFERENCES "payer"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "patient_charge" ADD CONSTRAINT "FK_c451f8f9ec0b021f96c80315527" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "patient_charge" ADD CONSTRAINT "FK_c7c5a12e4eb64cdd681b7a245fc" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "patient_charge" ADD CONSTRAINT "FK_1fc2bd62c8677e84c4fa3f68a89" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "patient_charge" ADD CONSTRAINT "FK_60d86b5be102cf7254b9c40fb65" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        // Hand-written: consumables requested for an encounter; schedules of the new jobs.
        await queryRunner.query(`ALTER TABLE "store_requisition_line" ADD CONSTRAINT "fk_sr_line_encounter" FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT`);
        await queryRunner.query(`UPDATE system_setting SET value = value || '{"hmis.dispatch": "* * * * *", "hmis.poll": "* * * * *", "hmis.monitor": "*/15 * * * *"}'::jsonb WHERE key = 'jobs.schedules'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE system_setting SET value = value - 'hmis.dispatch' - 'hmis.poll' - 'hmis.monitor' WHERE key = 'jobs.schedules'`);
        await queryRunner.query(`ALTER TABLE "store_requisition_line" DROP CONSTRAINT "fk_sr_line_encounter"`);
        await queryRunner.query(`ALTER TABLE "patient_charge" DROP CONSTRAINT "FK_60d86b5be102cf7254b9c40fb65"`);
        await queryRunner.query(`ALTER TABLE "patient_charge" DROP CONSTRAINT "FK_1fc2bd62c8677e84c4fa3f68a89"`);
        await queryRunner.query(`ALTER TABLE "patient_charge" DROP CONSTRAINT "FK_c7c5a12e4eb64cdd681b7a245fc"`);
        await queryRunner.query(`ALTER TABLE "patient_charge" DROP CONSTRAINT "FK_c451f8f9ec0b021f96c80315527"`);
        await queryRunner.query(`ALTER TABLE "encounter" DROP CONSTRAINT "FK_0d26fd103fc226cf7e1707ff09b"`);
        await queryRunner.query(`ALTER TABLE "encounter" DROP CONSTRAINT "FK_4ac21babaf89a17c455162d87ce"`);
        await queryRunner.query(`ALTER TABLE "encounter" DROP CONSTRAINT "FK_229e2fb2c0e5101c3a9e7921367"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1357fddc448d9157b48ff718c1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_913fab5a18f6e6fd6447c31ccd"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_be9fe9bf74a32013e0d81a5c98"`);
        await queryRunner.query(`ALTER TABLE "dispense" DROP COLUMN "billing_mode"`);
        await queryRunner.query(`ALTER TABLE "prescription_line" DROP COLUMN "daily_quantity"`);
        await queryRunner.query(`ALTER TABLE "prescription_line" DROP COLUMN "hmis_drug_code"`);
        await queryRunner.query(`ALTER TABLE "prescription_line" DROP COLUMN "external_ref"`);
        await queryRunner.query(`ALTER TABLE "prescription" DROP COLUMN "supply_mode"`);
        await queryRunner.query(`DROP TYPE "public"."supply_mode"`);
        await queryRunner.query(`ALTER TABLE "prescription" DROP COLUMN "encounter_id"`);
        await queryRunner.query(`ALTER TABLE "patient" DROP COLUMN "synced_at"`);
        await queryRunner.query(`ALTER TABLE "patient" DROP COLUMN "external_id"`);
        await queryRunner.query(`ALTER TABLE "store_requisition_line" DROP COLUMN "encounter_id"`);
        await queryRunner.query(`DROP TABLE "patient_charge"`);
        await queryRunner.query(`DROP TYPE "public"."patient_charge_status"`);
        await queryRunner.query(`DROP TYPE "public"."patient_charge_source"`);
        await queryRunner.query(`DROP TABLE "hmis_message"`);
        await queryRunner.query(`DROP TYPE "public"."hmis_message_status"`);
        await queryRunner.query(`DROP TYPE "public"."hmis_message_type"`);
        await queryRunner.query(`DROP TYPE "public"."hmis_direction"`);
        await queryRunner.query(`DROP TABLE "encounter"`);
        await queryRunner.query(`DROP TYPE "public"."encounter_status"`);
        await queryRunner.query(`DROP TYPE "public"."encounter_class"`);
        await queryRunner.query(`DROP TABLE "hmis_code_mapping"`);
        await queryRunner.query(`DROP TYPE "public"."hmis_mapping_kind"`);
        await queryRunner.query(`DROP TABLE "hmis_connection"`);
        await queryRunner.query(`DROP TYPE "public"."hmis_billing_mode"`);
        await queryRunner.query(`DROP TYPE "public"."hmis_adapter_kind"`);
        // The HMIS notification category value stays (Postgres cannot drop an enum value).
    }

}
