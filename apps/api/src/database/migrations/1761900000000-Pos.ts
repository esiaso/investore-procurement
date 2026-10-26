import { MigrationInterface, QueryRunner } from "typeorm";

export class Pos1761900000000 implements MigrationInterface {
    name = 'Pos1761900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "pos_terminal" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(40) NOT NULL, "name" character varying(200) NOT NULL, "store_id" uuid NOT NULL, "default_price_list_id" uuid, "is_active" boolean NOT NULL DEFAULT true, "last_seen_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_pos_terminal" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d84cb246e6906968b6b0fca1bc" ON "pos_terminal" ("code") `);
        await queryRunner.query(`CREATE TYPE "public"."pos_shift_status" AS ENUM('OPEN', 'CLOSED')`);
        await queryRunner.query(`CREATE TYPE "public"."variance_status" AS ENUM('NONE', 'PENDING', 'APPROVED', 'REJECTED')`);
        await queryRunner.query(`CREATE TABLE "pos_shift" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "terminal_id" uuid NOT NULL, "store_id" uuid NOT NULL, "cashier_id" uuid NOT NULL, "status" "public"."pos_shift_status" NOT NULL DEFAULT 'OPEN', "opened_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "opening_float" numeric(18,4) NOT NULL, "closed_at" TIMESTAMP WITH TIME ZONE, "counted_cash" numeric(18,4), "denominations" jsonb, "expected_cash" numeric(18,4), "variance" numeric(18,4), "variance_status" "public"."variance_status" NOT NULL DEFAULT 'NONE', "close_note" character varying(500), "decided_by" uuid, "decided_at" TIMESTAMP WITH TIME ZONE, "decision_note" character varying(500), "z_report" jsonb, CONSTRAINT "pk_pos_shift" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1ac5e7988997297a0f253a4924" ON "pos_shift" ("number") `);
        await queryRunner.query(`CREATE INDEX "IDX_7a7718efbe26d8589087ac3b1a" ON "pos_shift" ("cashier_id", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_7deb12d063e96163ea1c91d35a" ON "pos_shift" ("terminal_id", "status") `);
        await queryRunner.query(`CREATE TYPE "public"."pos_sale_status" AS ENUM('COMPLETED', 'VOIDED', 'PARTLY_REFUNDED', 'REFUNDED')`);
        await queryRunner.query(`CREATE TABLE "pos_sale" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "invoice_id" uuid NOT NULL, "client_ref" character varying(100) NOT NULL, "shift_id" uuid NOT NULL, "terminal_id" uuid NOT NULL, "store_id" uuid NOT NULL, "cashier_id" uuid NOT NULL, "customer_id" uuid, "status" "public"."pos_sale_status" NOT NULL DEFAULT 'COMPLETED', "offline" boolean NOT NULL DEFAULT false, "sold_at" TIMESTAMP WITH TIME ZONE NOT NULL, "total" numeric(18,4) NOT NULL, "discount_amount" numeric(18,4) NOT NULL DEFAULT '0', "prescription_ref" character varying(100), "pharmacist_id" uuid, "override_by" uuid, "points_earned" integer NOT NULL DEFAULT '0', "points_redeemed" integer NOT NULL DEFAULT '0', CONSTRAINT "pk_pos_sale" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e4b0eee4f8670545a5bf4c7f6c" ON "pos_sale" ("invoice_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7f96278d668ebde98fcfdde419" ON "pos_sale" ("client_ref") `);
        await queryRunner.query(`CREATE INDEX "IDX_bbe69defc43356a73ce4315e19" ON "pos_sale" ("customer_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8d891656a57282db6338ff58ec" ON "pos_sale" ("shift_id") `);
        await queryRunner.query(`CREATE TYPE "public"."pos_event_type" AS ENUM('VOID_LINE', 'VOID_SALE', 'REFUND', 'DISCOUNT_OVERRIDE', 'PHARMACIST_APPROVAL', 'INTERACTION_OVERRIDE', 'ACCOUNT_PAYMENT', 'OFFLINE_REJECTED')`);
        await queryRunner.query(`CREATE TABLE "pos_event" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" "public"."pos_event_type" NOT NULL, "shift_id" uuid, "terminal_id" uuid, "sale_id" uuid, "user_id" uuid NOT NULL, "approved_by" uuid, "amount" numeric(18,4), "reason" character varying(500), "details" jsonb NOT NULL DEFAULT '{}'::jsonb, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_pos_event" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6b2a02161c730ab79e3839c1d2" ON "pos_event" ("at") `);
        await queryRunner.query(`CREATE INDEX "IDX_b84d50cfb3ed5f716deb1b4d7b" ON "pos_event" ("shift_id") `);
        await queryRunner.query(`CREATE TABLE "customer" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(40) NOT NULL, "name" character varying(200) NOT NULL, "phone" character varying(20), "kra_pin" character varying(11), "price_list_id" uuid, "credit_allowed" boolean NOT NULL DEFAULT false, "credit_limit" numeric(18,4) NOT NULL DEFAULT '0', "loyalty_points" integer NOT NULL DEFAULT '0', "patient_id" uuid, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_customer" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_68db634015cb7defd6b98f910f" ON "customer" ("code") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b831c5f75cabddf9e9a0c8442d" ON "customer" ("phone") WHERE "phone" IS NOT NULL`);
        await queryRunner.query(`CREATE TYPE "public"."customer_ledger_type" AS ENUM('SALE', 'PAYMENT', 'REFUND')`);
        await queryRunner.query(`CREATE TABLE "customer_ledger" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "customer_id" uuid NOT NULL, "type" "public"."customer_ledger_type" NOT NULL, "amount" numeric(18,4) NOT NULL, "invoice_id" uuid, "reference" character varying(100), "user_id" uuid, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_customer_ledger" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1788bfe98646189bb4c442913c" ON "customer_ledger" ("customer_id", "at") `);
        await queryRunner.query(`CREATE TABLE "pos_promotion" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(40) NOT NULL, "name" character varying(200) NOT NULL, "item_id" uuid, "category_id" uuid, "discount_percent" numeric(7,4) NOT NULL, "min_qty" numeric(18,4) NOT NULL DEFAULT '1', "starts_on" date NOT NULL, "ends_on" date NOT NULL, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_pos_promotion" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a844a6a1f046ddfb6744a2967b" ON "pos_promotion" ("code") `);
        await queryRunner.query(`CREATE TYPE "public"."mpesa_environment" AS ENUM('SANDBOX', 'PRODUCTION', 'MOCK')`);
        await queryRunner.query(`CREATE TABLE "mpesa_config" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(40) NOT NULL, "environment" "public"."mpesa_environment" NOT NULL, "shortcode" character varying(20) NOT NULL, "transaction_type" character varying(40) NOT NULL DEFAULT 'CustomerPayBillOnline', "party_b" character varying(20), "consumer_key_enc" character varying(500), "consumer_secret_enc" character varying(500), "passkey_enc" character varying(500), "callback_base_url" character varying(300), "callback_token" character varying(100) NOT NULL, "api_base_url" character varying(300), "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_mpesa_config" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ee53ab02fb6fc15a0f6b7dd01e" ON "mpesa_config" ("code") `);
        await queryRunner.query(`CREATE TYPE "public"."mpesa_method" AS ENUM('STK', 'C2B', 'MANUAL')`);
        await queryRunner.query(`CREATE TYPE "public"."mpesa_status" AS ENUM('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT')`);
        await queryRunner.query(`CREATE TABLE "mpesa_transaction" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "method" "public"."mpesa_method" NOT NULL, "status" "public"."mpesa_status" NOT NULL DEFAULT 'PENDING', "terminal_id" uuid, "shift_id" uuid, "sale_id" uuid, "phone" character varying(15), "amount" numeric(18,4) NOT NULL, "account_ref" character varying(40), "merchant_request_id" character varying(100), "checkout_request_id" character varying(100), "result_code" character varying(10), "result_desc" character varying(300), "receipt_no" character varying(20), "transaction_date" TIMESTAMP WITH TIME ZONE, "payer_name" character varying(200), "verified" boolean NOT NULL DEFAULT true, "raw" jsonb, "used_at" TIMESTAMP WITH TIME ZONE, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_mpesa_transaction" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2739e3dd7c5dcc15609e3fd062" ON "mpesa_transaction" ("checkout_request_id") WHERE "checkout_request_id" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5a9f1dde9cf6b513f93c1e2e98" ON "mpesa_transaction" ("receipt_no") WHERE "receipt_no" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_bdaf6a7c1891486cb48c28e693" ON "mpesa_transaction" ("status", "created_at") `);
        await queryRunner.query(`ALTER TABLE "generic" ADD "max_qty_per_sale" numeric(18,4)`);
        await queryRunner.query(`ALTER TABLE "pos_terminal" ADD CONSTRAINT "FK_9189d5d0bf80ccd9ed20ff86737" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pos_terminal" ADD CONSTRAINT "FK_619e8ed06927539c5bdb7997a97" FOREIGN KEY ("default_price_list_id") REFERENCES "price_list"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pos_shift" ADD CONSTRAINT "FK_911bb308a67efdd227f50cc569b" FOREIGN KEY ("terminal_id") REFERENCES "pos_terminal"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pos_sale" ADD CONSTRAINT "FK_e4b0eee4f8670545a5bf4c7f6c4" FOREIGN KEY ("invoice_id") REFERENCES "sales_invoice"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pos_sale" ADD CONSTRAINT "FK_8d891656a57282db6338ff58ec1" FOREIGN KEY ("shift_id") REFERENCES "pos_shift"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pos_sale" ADD CONSTRAINT "FK_bbe69defc43356a73ce4315e190" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "customer" ADD CONSTRAINT "FK_3ecca0112440df0c058bf919d02" FOREIGN KEY ("price_list_id") REFERENCES "price_list"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pos_promotion" ADD CONSTRAINT "FK_aac14930830334c95c6912103d9" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pos_promotion" ADD CONSTRAINT "FK_24bb6d6404718fe9bfc93b005e4" FOREIGN KEY ("category_id") REFERENCES "item_category"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        // Hand-written: tills may not oversell a shift twice; sale and event rows are append-only for audit.
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_pos_shift_open_terminal" ON "pos_shift" ("terminal_id") WHERE status = 'OPEN'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_pos_shift_open_cashier" ON "pos_shift" ("cashier_id") WHERE status = 'OPEN'`);
        await queryRunner.query(`CREATE FUNCTION pos_event_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'pos_event rows cannot be changed or deleted'; END $$ LANGUAGE plpgsql`);
        await queryRunner.query(`CREATE TRIGGER trg_pos_event_immutable BEFORE UPDATE OR DELETE ON pos_event FOR EACH ROW EXECUTE FUNCTION pos_event_immutable()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER trg_pos_event_immutable ON pos_event`);
        await queryRunner.query(`DROP FUNCTION pos_event_immutable()`);
        await queryRunner.query(`DROP INDEX "uq_pos_shift_open_cashier"`);
        await queryRunner.query(`DROP INDEX "uq_pos_shift_open_terminal"`);
        await queryRunner.query(`ALTER TABLE "generic" DROP COLUMN "max_qty_per_sale"`);
        await queryRunner.query(`ALTER TABLE "pos_promotion" DROP CONSTRAINT "FK_24bb6d6404718fe9bfc93b005e4"`);
        await queryRunner.query(`ALTER TABLE "pos_promotion" DROP CONSTRAINT "FK_aac14930830334c95c6912103d9"`);
        await queryRunner.query(`ALTER TABLE "customer" DROP CONSTRAINT "FK_3ecca0112440df0c058bf919d02"`);
        await queryRunner.query(`ALTER TABLE "pos_sale" DROP CONSTRAINT "FK_bbe69defc43356a73ce4315e190"`);
        await queryRunner.query(`ALTER TABLE "pos_sale" DROP CONSTRAINT "FK_8d891656a57282db6338ff58ec1"`);
        await queryRunner.query(`ALTER TABLE "pos_sale" DROP CONSTRAINT "FK_e4b0eee4f8670545a5bf4c7f6c4"`);
        await queryRunner.query(`ALTER TABLE "pos_shift" DROP CONSTRAINT "FK_911bb308a67efdd227f50cc569b"`);
        await queryRunner.query(`ALTER TABLE "pos_terminal" DROP CONSTRAINT "FK_619e8ed06927539c5bdb7997a97"`);
        await queryRunner.query(`ALTER TABLE "pos_terminal" DROP CONSTRAINT "FK_9189d5d0bf80ccd9ed20ff86737"`);
        await queryRunner.query(`DROP TABLE "mpesa_transaction"`);
        await queryRunner.query(`DROP TYPE "public"."mpesa_status"`);
        await queryRunner.query(`DROP TYPE "public"."mpesa_method"`);
        await queryRunner.query(`DROP TABLE "mpesa_config"`);
        await queryRunner.query(`DROP TYPE "public"."mpesa_environment"`);
        await queryRunner.query(`DROP TABLE "pos_promotion"`);
        await queryRunner.query(`DROP TABLE "customer_ledger"`);
        await queryRunner.query(`DROP TYPE "public"."customer_ledger_type"`);
        await queryRunner.query(`DROP TABLE "customer"`);
        await queryRunner.query(`DROP TABLE "pos_event"`);
        await queryRunner.query(`DROP TYPE "public"."pos_event_type"`);
        await queryRunner.query(`DROP TABLE "pos_sale"`);
        await queryRunner.query(`DROP TYPE "public"."pos_sale_status"`);
        await queryRunner.query(`DROP TABLE "pos_shift"`);
        await queryRunner.query(`DROP TYPE "public"."variance_status"`);
        await queryRunner.query(`DROP TYPE "public"."pos_shift_status"`);
        await queryRunner.query(`DROP TABLE "pos_terminal"`);
    }

}
