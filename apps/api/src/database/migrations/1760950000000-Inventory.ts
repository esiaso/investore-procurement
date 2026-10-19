import { MigrationInterface, QueryRunner } from "typeorm";

export class Inventory1760950000000 implements MigrationInterface {
    name = 'Inventory1760950000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."batch_hold_status" AS ENUM('NONE', 'QUARANTINE', 'RECALL', 'EXPIRED')`);
        await queryRunner.query(`CREATE TABLE "batch" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "item_id" uuid NOT NULL, "batch_no" character varying(60) NOT NULL, "manufacture_date" date, "expiry_date" date, "unit_cost" numeric(18,4) NOT NULL, "hold_status" "public"."batch_hold_status" NOT NULL DEFAULT 'NONE', "hold_reason" character varying(500), "funding_source" character varying(100), "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_batch" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_63cec325b57ed37593a66873fa" ON "batch" ("expiry_date") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c365badbd4f73c31e901b66a90" ON "batch" ("item_id", "batch_no") `);
        await queryRunner.query(`CREATE TABLE "stock_balance" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "store_id" uuid NOT NULL, "bin_id" uuid, "item_id" uuid NOT NULL, "batch_id" uuid NOT NULL, "on_hand" numeric(18,4) NOT NULL DEFAULT '0', "reserved" numeric(18,4) NOT NULL DEFAULT '0', "in_transit" numeric(18,4) NOT NULL DEFAULT '0', "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_abad132c00dead896e62fb265c" CHECK ("in_transit" >= 0), CONSTRAINT "CHK_3f8f06ba7f056012526268de6b" CHECK ("reserved" >= 0), CONSTRAINT "CHK_41515769771da82502b963979f" CHECK ("on_hand" >= 0), CONSTRAINT "pk_stock_balance" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7b9cc86d2e0c604213904f2c30" ON "stock_balance" ("batch_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_a50119e7fff048aff1efe081ae" ON "stock_balance" ("item_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_fe0aaef57007db1e49815ee6cb" ON "stock_balance" ("store_id", "item_id") `);
        await queryRunner.query(`CREATE TYPE "public"."stock_txn_type" AS ENUM('OPENING', 'RECEIPT', 'ADJUSTMENT', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT', 'TRANSFER_DISCREPANCY', 'STOCK_TAKE', 'ISSUE')`);
        await queryRunner.query(`CREATE TABLE "stock_transaction" ("id" BIGSERIAL NOT NULL, "txn_type" "public"."stock_txn_type" NOT NULL, "store_id" uuid NOT NULL, "bin_id" uuid, "item_id" uuid NOT NULL, "batch_id" uuid NOT NULL, "quantity" numeric(18,4) NOT NULL, "in_transit_delta" numeric(18,4) NOT NULL DEFAULT '0', "unit_cost" numeric(18,6) NOT NULL, "value_delta" numeric(20,4) NOT NULL, "counterpart_store_id" uuid, "source_doc_type" character varying(20) NOT NULL, "source_doc_id" uuid, "source_doc_no" character varying(60), "reason_code" character varying(40), "fefo_override_reason" character varying(500), "department_id" uuid, "patient_ref" character varying(100), "user_id" uuid, "second_signer_id" uuid, "effective_date" date NOT NULL, "posted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_stock_transaction" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a3f444c7019fa9b951c92ee661" ON "stock_transaction" ("effective_date") `);
        await queryRunner.query(`CREATE INDEX "IDX_451be122392792c644d7026a94" ON "stock_transaction" ("source_doc_type", "source_doc_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_347ebf04e1e04924698557a065" ON "stock_transaction" ("batch_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_dbced27732b0d289fa79e23be9" ON "stock_transaction" ("store_id", "item_id", "posted_at") `);
        await queryRunner.query(`CREATE TABLE "item_store_cost" ("store_id" uuid NOT NULL, "item_id" uuid NOT NULL, "avg_cost" numeric(18,6) NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_item_store_cost" PRIMARY KEY ("store_id", "item_id"))`);
        await queryRunner.query(`CREATE TABLE "store_period_lock" ("store_id" uuid NOT NULL, "locked_until" date NOT NULL, "updated_by" uuid, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_store_period_lock" PRIMARY KEY ("store_id"))`);
        await queryRunner.query(`CREATE TYPE "public"."adjustment_direction" AS ENUM('INCREASE', 'DECREASE', 'BOTH')`);
        await queryRunner.query(`CREATE TABLE "adjustment_reason" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(40) NOT NULL, "name" character varying(200) NOT NULL, "direction" "public"."adjustment_direction" NOT NULL, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_adjustment_reason" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f4093d1fac0a78b3ac955757d6" ON "adjustment_reason" ("code") `);
        await queryRunner.query(`CREATE TYPE "public"."stock_receipt_type" AS ENUM('OPENING', 'RECEIPT')`);
        await queryRunner.query(`CREATE TABLE "stock_receipt" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "type" "public"."stock_receipt_type" NOT NULL, "store_id" uuid NOT NULL, "receipt_date" date NOT NULL, "notes" character varying(500), CONSTRAINT "pk_stock_receipt" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6725ffcdc4718314cf2378e3e6" ON "stock_receipt" ("number") `);
        await queryRunner.query(`CREATE TABLE "stock_receipt_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "receipt_id" uuid NOT NULL, "item_id" uuid NOT NULL, "batch_id" uuid NOT NULL, "bin_id" uuid, "quantity" numeric(18,4) NOT NULL, "unit_cost" numeric(18,4) NOT NULL, CONSTRAINT "pk_stock_receipt_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."adjustment_status" AS ENUM('DRAFT', 'SUBMITTED', 'PARTIALLY_APPROVED', 'POSTED', 'REJECTED')`);
        await queryRunner.query(`CREATE TABLE "stock_adjustment" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "store_id" uuid NOT NULL, "reason_code" character varying(40) NOT NULL, "status" "public"."adjustment_status" NOT NULL DEFAULT 'DRAFT', "adjustment_date" date NOT NULL, "notes" character varying(1000), "total_value" numeric(18,4) NOT NULL DEFAULT '0', "requires_second_approval" boolean NOT NULL DEFAULT false, "submitted_by" uuid, "first_approved_by" uuid, "first_approved_at" TIMESTAMP WITH TIME ZONE, "second_approved_by" uuid, "second_approved_at" TIMESTAMP WITH TIME ZONE, "rejected_by" uuid, "rejection_reason" character varying(500), "posted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_stock_adjustment" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0004680f808de00929dafb3bad" ON "stock_adjustment" ("number") `);
        await queryRunner.query(`CREATE TABLE "stock_adjustment_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "adjustment_id" uuid NOT NULL, "item_id" uuid NOT NULL, "batch_id" uuid NOT NULL, "bin_id" uuid, "quantity" numeric(18,4) NOT NULL, "unit_cost" numeric(18,4) NOT NULL, CONSTRAINT "pk_stock_adjustment_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."transfer_status" AS ENUM('REQUESTED', 'DISPATCHED', 'RECEIVED', 'RECEIVED_WITH_DISCREPANCY', 'CANCELLED')`);
        await queryRunner.query(`CREATE TABLE "stock_transfer" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "from_store_id" uuid NOT NULL, "to_store_id" uuid NOT NULL, "status" "public"."transfer_status" NOT NULL DEFAULT 'REQUESTED', "notes" character varying(1000), "requested_by" uuid, "dispatched_by" uuid, "dispatched_at" TIMESTAMP WITH TIME ZONE, "received_by" uuid, "received_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_stock_transfer" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6ffaab1ac9225c58e8bb96132d" ON "stock_transfer" ("number") `);
        await queryRunner.query(`CREATE TABLE "stock_transfer_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "transfer_id" uuid NOT NULL, "item_id" uuid NOT NULL, "requested_qty" numeric(18,4) NOT NULL, CONSTRAINT "pk_stock_transfer_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "stock_transfer_allocation" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "line_id" uuid NOT NULL, "batch_id" uuid NOT NULL, "from_bin_id" uuid, "dispatched_qty" numeric(18,4) NOT NULL, "received_qty" numeric(18,4), "to_bin_id" uuid, "unit_cost" numeric(18,6) NOT NULL, "discrepancy_reason_code" character varying(40), "discrepancy_notes" character varying(500), CONSTRAINT "pk_stock_transfer_allocation" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."stock_take_type" AS ENUM('FULL', 'CYCLE')`);
        await queryRunner.query(`CREATE TYPE "public"."stock_take_status" AS ENUM('DRAFT', 'COUNTING', 'REVIEW', 'POSTED', 'CANCELLED')`);
        await queryRunner.query(`CREATE TABLE "stock_take" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "store_id" uuid NOT NULL, "type" "public"."stock_take_type" NOT NULL, "blind" boolean NOT NULL DEFAULT true, "status" "public"."stock_take_status" NOT NULL DEFAULT 'DRAFT', "item_ids" text array NOT NULL DEFAULT '{}', "notes" character varying(1000), "frozen_at" TIMESTAMP WITH TIME ZONE, "submitted_by" uuid, "approved_by" uuid, "posted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_stock_take" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f6839f6a8776e468599b9f7cd0" ON "stock_take" ("number") `);
        await queryRunner.query(`CREATE TABLE "stock_take_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "stock_take_id" uuid NOT NULL, "item_id" uuid NOT NULL, "batch_id" uuid NOT NULL, "bin_id" uuid, "system_qty" numeric(18,4) NOT NULL, "counted_qty" numeric(18,4), "counted_by" uuid, "notes" character varying(500), CONSTRAINT "pk_stock_take_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a7952752105529c8d07fe43f05" ON "stock_take_line" ("stock_take_id", "item_id") `);
        await queryRunner.query(`ALTER TABLE "batch" ADD CONSTRAINT "FK_4be0d33148594e7326423343360" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_balance" ADD CONSTRAINT "FK_bc0207cb20f160e73541feeb17f" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_balance" ADD CONSTRAINT "FK_60d819100999ed2259810164838" FOREIGN KEY ("bin_id") REFERENCES "bin"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_balance" ADD CONSTRAINT "FK_a50119e7fff048aff1efe081aef" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_balance" ADD CONSTRAINT "FK_7b9cc86d2e0c604213904f2c309" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_transaction" ADD CONSTRAINT "FK_92deea27a1ae4c53350d8a28945" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_transaction" ADD CONSTRAINT "FK_4a150aab0494285679190a1c0b5" FOREIGN KEY ("bin_id") REFERENCES "bin"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_transaction" ADD CONSTRAINT "FK_65336dbc587fbe4803c2ef52898" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_transaction" ADD CONSTRAINT "FK_347ebf04e1e04924698557a0652" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "store_period_lock" ADD CONSTRAINT "FK_f1e858771cd117cde5e9725281c" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_receipt" ADD CONSTRAINT "FK_4cb8399da68c03406d2884633b9" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_receipt_line" ADD CONSTRAINT "FK_9f71b9239d86519892f97e29f21" FOREIGN KEY ("receipt_id") REFERENCES "stock_receipt"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_receipt_line" ADD CONSTRAINT "FK_2d4006af58e29c87f688fcd3e2f" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_receipt_line" ADD CONSTRAINT "FK_4dacf43616f82fa11ba0e7a6382" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_adjustment" ADD CONSTRAINT "FK_ab0c45ed247b0456bbc7f4a327f" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_adjustment_line" ADD CONSTRAINT "FK_3db4f10ce5db1f656234d749e29" FOREIGN KEY ("adjustment_id") REFERENCES "stock_adjustment"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_adjustment_line" ADD CONSTRAINT "FK_1152dcdf79a8121d2b2a5083e9d" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_adjustment_line" ADD CONSTRAINT "FK_799d7057c21a692d449b7896120" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_transfer" ADD CONSTRAINT "FK_59bb9f3bb2c3d4a350da5c1761e" FOREIGN KEY ("from_store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_transfer" ADD CONSTRAINT "FK_6ddafc86cf7cb5fd55e59c5db93" FOREIGN KEY ("to_store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "FK_820661deb3c482aac36c2adc636" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfer"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "FK_4b449f11b36193a80eaf6e74a75" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_transfer_allocation" ADD CONSTRAINT "FK_4bb902e3e6dc36d672f2a7ed381" FOREIGN KEY ("line_id") REFERENCES "stock_transfer_line"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_transfer_allocation" ADD CONSTRAINT "FK_7a655aebaf191f611d1417e2611" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_take" ADD CONSTRAINT "FK_7f55626b0904f46cdea2f4bb9d5" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_take_line" ADD CONSTRAINT "FK_7adcf767913c1d9fae661cf5713" FOREIGN KEY ("stock_take_id") REFERENCES "stock_take"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_take_line" ADD CONSTRAINT "FK_2f41930e7f49e7db60ca5c8af3d" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_take_line" ADD CONSTRAINT "FK_056a25ceb833a61db9ccd1831b5" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        // --- hand-written: one balance row per store × bin × batch (bin may be NULL)
        await queryRunner.query(`ALTER TABLE "stock_balance" ADD CONSTRAINT "uq_stock_balance_location" UNIQUE NULLS NOT DISTINCT ("store_id", "bin_id", "batch_id")`);
        // Stock-on-hand screens filter out empty rows.
        await queryRunner.query(`CREATE INDEX "ix_stock_balance_store_nonzero" ON "stock_balance" ("store_id", "item_id") WHERE "on_hand" <> 0 OR "in_transit" <> 0`);
        // The ledger is append-only, like the audit log (the shared trigger function now names the table).
        await queryRunner.query(`
          CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
          END;
          $$ LANGUAGE plpgsql`);
        await queryRunner.query(`CREATE TRIGGER stock_transaction_no_update_delete BEFORE UPDATE OR DELETE ON stock_transaction FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()`);
        await queryRunner.query(`CREATE TRIGGER stock_transaction_no_truncate BEFORE TRUNCATE ON stock_transaction FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER stock_transaction_no_truncate ON stock_transaction`);
        await queryRunner.query(`DROP TRIGGER stock_transaction_no_update_delete ON stock_transaction`);
        await queryRunner.query(`DROP INDEX "ix_stock_balance_store_nonzero"`);
        await queryRunner.query(`ALTER TABLE "stock_balance" DROP CONSTRAINT "uq_stock_balance_location"`);
        await queryRunner.query(`ALTER TABLE "stock_take_line" DROP CONSTRAINT "FK_056a25ceb833a61db9ccd1831b5"`);
        await queryRunner.query(`ALTER TABLE "stock_take_line" DROP CONSTRAINT "FK_2f41930e7f49e7db60ca5c8af3d"`);
        await queryRunner.query(`ALTER TABLE "stock_take_line" DROP CONSTRAINT "FK_7adcf767913c1d9fae661cf5713"`);
        await queryRunner.query(`ALTER TABLE "stock_take" DROP CONSTRAINT "FK_7f55626b0904f46cdea2f4bb9d5"`);
        await queryRunner.query(`ALTER TABLE "stock_transfer_allocation" DROP CONSTRAINT "FK_7a655aebaf191f611d1417e2611"`);
        await queryRunner.query(`ALTER TABLE "stock_transfer_allocation" DROP CONSTRAINT "FK_4bb902e3e6dc36d672f2a7ed381"`);
        await queryRunner.query(`ALTER TABLE "stock_transfer_line" DROP CONSTRAINT "FK_4b449f11b36193a80eaf6e74a75"`);
        await queryRunner.query(`ALTER TABLE "stock_transfer_line" DROP CONSTRAINT "FK_820661deb3c482aac36c2adc636"`);
        await queryRunner.query(`ALTER TABLE "stock_transfer" DROP CONSTRAINT "FK_6ddafc86cf7cb5fd55e59c5db93"`);
        await queryRunner.query(`ALTER TABLE "stock_transfer" DROP CONSTRAINT "FK_59bb9f3bb2c3d4a350da5c1761e"`);
        await queryRunner.query(`ALTER TABLE "stock_adjustment_line" DROP CONSTRAINT "FK_799d7057c21a692d449b7896120"`);
        await queryRunner.query(`ALTER TABLE "stock_adjustment_line" DROP CONSTRAINT "FK_1152dcdf79a8121d2b2a5083e9d"`);
        await queryRunner.query(`ALTER TABLE "stock_adjustment_line" DROP CONSTRAINT "FK_3db4f10ce5db1f656234d749e29"`);
        await queryRunner.query(`ALTER TABLE "stock_adjustment" DROP CONSTRAINT "FK_ab0c45ed247b0456bbc7f4a327f"`);
        await queryRunner.query(`ALTER TABLE "stock_receipt_line" DROP CONSTRAINT "FK_4dacf43616f82fa11ba0e7a6382"`);
        await queryRunner.query(`ALTER TABLE "stock_receipt_line" DROP CONSTRAINT "FK_2d4006af58e29c87f688fcd3e2f"`);
        await queryRunner.query(`ALTER TABLE "stock_receipt_line" DROP CONSTRAINT "FK_9f71b9239d86519892f97e29f21"`);
        await queryRunner.query(`ALTER TABLE "stock_receipt" DROP CONSTRAINT "FK_4cb8399da68c03406d2884633b9"`);
        await queryRunner.query(`ALTER TABLE "store_period_lock" DROP CONSTRAINT "FK_f1e858771cd117cde5e9725281c"`);
        await queryRunner.query(`ALTER TABLE "stock_transaction" DROP CONSTRAINT "FK_347ebf04e1e04924698557a0652"`);
        await queryRunner.query(`ALTER TABLE "stock_transaction" DROP CONSTRAINT "FK_65336dbc587fbe4803c2ef52898"`);
        await queryRunner.query(`ALTER TABLE "stock_transaction" DROP CONSTRAINT "FK_4a150aab0494285679190a1c0b5"`);
        await queryRunner.query(`ALTER TABLE "stock_transaction" DROP CONSTRAINT "FK_92deea27a1ae4c53350d8a28945"`);
        await queryRunner.query(`ALTER TABLE "stock_balance" DROP CONSTRAINT "FK_7b9cc86d2e0c604213904f2c309"`);
        await queryRunner.query(`ALTER TABLE "stock_balance" DROP CONSTRAINT "FK_a50119e7fff048aff1efe081aef"`);
        await queryRunner.query(`ALTER TABLE "stock_balance" DROP CONSTRAINT "FK_60d819100999ed2259810164838"`);
        await queryRunner.query(`ALTER TABLE "stock_balance" DROP CONSTRAINT "FK_bc0207cb20f160e73541feeb17f"`);
        await queryRunner.query(`ALTER TABLE "batch" DROP CONSTRAINT "FK_4be0d33148594e7326423343360"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a7952752105529c8d07fe43f05"`);
        await queryRunner.query(`DROP TABLE "stock_take_line"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f6839f6a8776e468599b9f7cd0"`);
        await queryRunner.query(`DROP TABLE "stock_take"`);
        await queryRunner.query(`DROP TYPE "public"."stock_take_status"`);
        await queryRunner.query(`DROP TYPE "public"."stock_take_type"`);
        await queryRunner.query(`DROP TABLE "stock_transfer_allocation"`);
        await queryRunner.query(`DROP TABLE "stock_transfer_line"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6ffaab1ac9225c58e8bb96132d"`);
        await queryRunner.query(`DROP TABLE "stock_transfer"`);
        await queryRunner.query(`DROP TYPE "public"."transfer_status"`);
        await queryRunner.query(`DROP TABLE "stock_adjustment_line"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0004680f808de00929dafb3bad"`);
        await queryRunner.query(`DROP TABLE "stock_adjustment"`);
        await queryRunner.query(`DROP TYPE "public"."adjustment_status"`);
        await queryRunner.query(`DROP TABLE "stock_receipt_line"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6725ffcdc4718314cf2378e3e6"`);
        await queryRunner.query(`DROP TABLE "stock_receipt"`);
        await queryRunner.query(`DROP TYPE "public"."stock_receipt_type"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f4093d1fac0a78b3ac955757d6"`);
        await queryRunner.query(`DROP TABLE "adjustment_reason"`);
        await queryRunner.query(`DROP TYPE "public"."adjustment_direction"`);
        await queryRunner.query(`DROP TABLE "store_period_lock"`);
        await queryRunner.query(`DROP TABLE "item_store_cost"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dbced27732b0d289fa79e23be9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_347ebf04e1e04924698557a065"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_451be122392792c644d7026a94"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a3f444c7019fa9b951c92ee661"`);
        await queryRunner.query(`DROP TABLE "stock_transaction"`);
        await queryRunner.query(`DROP TYPE "public"."stock_txn_type"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fe0aaef57007db1e49815ee6cb"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a50119e7fff048aff1efe081ae"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7b9cc86d2e0c604213904f2c30"`);
        await queryRunner.query(`DROP TABLE "stock_balance"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c365badbd4f73c31e901b66a90"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_63cec325b57ed37593a66873fa"`);
        await queryRunner.query(`DROP TABLE "batch"`);
        await queryRunner.query(`DROP TYPE "public"."batch_hold_status"`);
    }

}
