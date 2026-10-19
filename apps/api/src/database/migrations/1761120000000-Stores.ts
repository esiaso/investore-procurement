import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Slice 4: internal requisitions, reservations, issue vouchers, department
 * returns, returns to supplier (upgraded from the slice-3 GRN reject note),
 * return reasons, quarantine bins and department-scoped approval steps.
 *
 * Hand-edited after generation: enum values are added with ADD VALUE (no
 * rewrite of the ledger), existing return notes are converted in place, and
 * the hand-written stock_balance constraint/index are left alone.
 */
export class Stores1761120000000 implements MigrationInterface {
    name = 'Stores1761120000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ---- enums extended in place
        await queryRunner.query(`ALTER TYPE "public"."approver_type" ADD VALUE IF NOT EXISTS 'DEPARTMENT_ROLE'`);
        await queryRunner.query(`ALTER TYPE "public"."stock_txn_type" ADD VALUE IF NOT EXISTS 'RETURN_IN'`);
        await queryRunner.query(`ALTER TYPE "public"."stock_txn_type" ADD VALUE IF NOT EXISTS 'SUPPLIER_RETURN'`);

        await queryRunner.query(`ALTER TABLE "approval_request" ADD "department_id" uuid`);
        await queryRunner.query(`ALTER TABLE "bin" ADD "is_quarantine" boolean NOT NULL DEFAULT false`);

        // ---- reservations
        await queryRunner.query(`CREATE TABLE "stock_reservation" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "requisition_id" uuid NOT NULL, "requisition_line_id" uuid NOT NULL, "store_id" uuid NOT NULL, "bin_id" uuid, "item_id" uuid NOT NULL, "batch_id" uuid NOT NULL, "quantity" numeric(18,4) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "released_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_stock_reservation" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_86aa285f2130d3b18ff8489ee8" ON "stock_reservation" ("store_id", "item_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_15fa00eb56f1b6a51229414392" ON "stock_reservation" ("requisition_line_id") `);

        // ---- internal requisitions and issues
        await queryRunner.query(`CREATE TYPE "public"."store_requisition_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_ISSUED', 'ISSUED', 'CLOSED', 'REJECTED', 'RETURNED', 'CANCELLED')`);
        await queryRunner.query(`CREATE TABLE "store_requisition" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "department_id" uuid NOT NULL, "store_id" uuid NOT NULL, "priority" "public"."requisition_priority" NOT NULL DEFAULT 'ROUTINE', "required_by" date, "status" "public"."store_requisition_status" NOT NULL DEFAULT 'DRAFT', "requested_by" uuid NOT NULL, "notes" character varying(1000), "estimated_value" numeric(18,4) NOT NULL DEFAULT '0', "approved_at" TIMESTAMP WITH TIME ZONE, "last_comment" character varying(1000), CONSTRAINT "pk_store_requisition" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_79792d311fa971170e8c57223c" ON "store_requisition" ("number") `);
        await queryRunner.query(`CREATE INDEX "IDX_4a402c0bcc5a0bb4086ab90e88" ON "store_requisition" ("department_id", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_ab206297ca452595ff58b6413c" ON "store_requisition" ("store_id", "status") `);
        await queryRunner.query(`CREATE TABLE "store_requisition_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "requisition_id" uuid NOT NULL, "line_no" integer NOT NULL, "item_id" uuid NOT NULL, "requested_qty" numeric(18,4) NOT NULL, "issued_qty" numeric(18,4) NOT NULL DEFAULT '0', "cancelled_qty" numeric(18,4) NOT NULL DEFAULT '0', "cancel_reason" character varying(500), "patient_ref" character varying(100), "notes" character varying(500), CONSTRAINT "pk_store_requisition_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "issue_voucher" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "requisition_id" uuid NOT NULL, "store_id" uuid NOT NULL, "department_id" uuid NOT NULL, "issue_date" date NOT NULL, "issued_by" uuid NOT NULL, "collected_by" character varying(200), "witness_id" uuid, "fefo_override_reason" character varying(500), "total_value" numeric(18,4) NOT NULL DEFAULT '0', "notes" character varying(1000), CONSTRAINT "pk_issue_voucher" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6387b48e74da14b366a4b3c33e" ON "issue_voucher" ("number") `);
        await queryRunner.query(`CREATE INDEX "IDX_373300e0761edd03214c3e102c" ON "issue_voucher" ("requisition_id") `);
        await queryRunner.query(`CREATE TABLE "issue_voucher_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "voucher_id" uuid NOT NULL, "requisition_line_id" uuid NOT NULL, "item_id" uuid NOT NULL, "batch_id" uuid NOT NULL, "bin_id" uuid, "quantity" numeric(18,4) NOT NULL, "unit_cost" numeric(18,6) NOT NULL, "value" numeric(18,4) NOT NULL, "fefo_overridden" boolean NOT NULL DEFAULT false, "scan_confirmed" boolean NOT NULL DEFAULT false, "patient_ref" character varying(100), "returned_qty" numeric(18,4) NOT NULL DEFAULT '0', CONSTRAINT "pk_issue_voucher_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9f2dc8fe3b88f5bec18d6d607d" ON "issue_voucher_line" ("batch_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_f3fc6fc3b9ecb782b91b974bab" ON "issue_voucher_line" ("requisition_line_id") `);

        // ---- department returns and reason codes
        await queryRunner.query(`CREATE TYPE "public"."department_return_status" AS ENUM('DRAFT', 'POSTED', 'CANCELLED')`);
        await queryRunner.query(`CREATE TABLE "department_return" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "department_id" uuid NOT NULL, "store_id" uuid NOT NULL, "status" "public"."department_return_status" NOT NULL DEFAULT 'DRAFT', "return_date" date, "requested_by" uuid NOT NULL, "received_by" uuid, "witness_id" uuid, "posted_at" TIMESTAMP WITH TIME ZONE, "total_value" numeric(18,4) NOT NULL DEFAULT '0', "notes" character varying(1000), CONSTRAINT "pk_department_return" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6796ce7422ce763765e355981d" ON "department_return" ("number") `);
        await queryRunner.query(`CREATE TYPE "public"."return_condition" AS ENUM('RESALEABLE', 'DAMAGED', 'EXPIRED')`);
        await queryRunner.query(`CREATE TABLE "department_return_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "return_id" uuid NOT NULL, "item_id" uuid NOT NULL, "batch_id" uuid NOT NULL, "issue_voucher_line_id" uuid, "quantity" numeric(18,4) NOT NULL, "reason_code" character varying(40) NOT NULL, "condition" "public"."return_condition" NOT NULL, "bin_id" uuid, "unit_cost" numeric(18,6) NOT NULL DEFAULT '0', "value" numeric(18,4) NOT NULL DEFAULT '0', "patient_ref" character varying(100), CONSTRAINT "pk_department_return_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."return_reason_kind" AS ENUM('DEPARTMENT', 'SUPPLIER', 'BOTH')`);
        await queryRunner.query(`CREATE TABLE "return_reason" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(40) NOT NULL, "name" character varying(200) NOT NULL, "kind" "public"."return_reason_kind" NOT NULL, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_return_reason" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1e50cee36b734e091abc6a9403" ON "return_reason" ("code") `);

        // ---- returns to supplier: new columns (nullable first), then convert existing GRN-reject notes
        await queryRunner.query(`CREATE TABLE "return_to_supplier_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "return_id" uuid NOT NULL, "item_id" uuid NOT NULL, "batch_id" uuid, "batch_no" character varying(60), "bin_id" uuid, "grn_line_id" uuid, "quantity" numeric(18,4) NOT NULL, "unit_cost" numeric(18,6) NOT NULL DEFAULT '0', "value" numeric(18,4) NOT NULL DEFAULT '0', "reason" character varying(500), CONSTRAINT "pk_return_to_supplier_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."supplier_return_source" AS ENUM('STOCK', 'GRN_REJECT')`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "source" "public"."supplier_return_source" NOT NULL DEFAULT 'GRN_REJECT'`);
        await queryRunner.query(`CREATE TYPE "public"."supplier_return_status" AS ENUM('DRAFT', 'DISPATCHED', 'CREDITED', 'CANCELLED')`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "status" "public"."supplier_return_status" NOT NULL DEFAULT 'DRAFT'`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "store_id" uuid`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "purchase_order_id" uuid`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "reason_code" character varying(40)`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "notes" character varying(1000)`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "total_value" numeric(18,4) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "return_date" date`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "dispatched_by" uuid`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "dispatched_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "witness_id" uuid`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "credit_note_no" character varying(60)`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "credit_note_date" date`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "credit_note_amount" numeric(18,4)`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "credit_recorded_by" uuid`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ALTER COLUMN "grn_id" DROP NOT NULL`);
        // Slice-3 notes were GRN inspection rejects: lines move to the new table, valued at the GRN cost (VAT included).
        await queryRunner.query(`
            INSERT INTO "return_to_supplier_line" ("return_id", "item_id", "batch_no", "grn_line_id", "quantity", "unit_cost", "value", "reason", "created_at")
            SELECT r.id, (l->>'itemId')::uuid, l->>'batchNo', gl.id, (l->>'quantity')::numeric,
                   COALESCE(gl.cost, 0), ROUND((l->>'quantity')::numeric * COALESCE(gl.cost, 0), 2), l->>'reason', r.created_at
              FROM "return_to_supplier" r
              CROSS JOIN LATERAL jsonb_array_elements(r.lines) l
              LEFT JOIN LATERAL (
                SELECT g.id, ROUND(g.unit_price / g.conversion_factor * (1 + g.tax_rate_percent / 100), 6) AS cost
                  FROM "grn_line" g
                 WHERE g.grn_id = r.grn_id AND g.item_id = (l->>'itemId')::uuid
                   AND g.batch_no IS NOT DISTINCT FROM l->>'batchNo' AND g.rejected_base_qty > 0
                 LIMIT 1) gl ON true`);
        await queryRunner.query(`
            UPDATE "return_to_supplier" r
               SET store_id = g.store_id, purchase_order_id = g.purchase_order_id, reason_code = 'INSPECTION_REJECT',
                   status = 'DISPATCHED', source = 'GRN_REJECT', return_date = g.received_date, dispatched_at = r.created_at,
                   total_value = COALESCE((SELECT SUM(x.value) FROM "return_to_supplier_line" x WHERE x.return_id = r.id), 0)
              FROM "goods_received_note" g WHERE g.id = r.grn_id`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ALTER COLUMN "store_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ALTER COLUMN "reason_code" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" DROP COLUMN "lines"`);
        await queryRunner.query(`CREATE INDEX "IDX_34ae8e7b668dbac7e543803e61" ON "return_to_supplier" ("supplier_id", "status") `);

        // ---- foreign keys
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD CONSTRAINT "FK_ddce1e9e684ccfd368ea9efb077" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD CONSTRAINT "FK_346b9f5a6500127923a0feedda6" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD CONSTRAINT "FK_99ea1c25d8cbc3cf14ecdb7dac3" FOREIGN KEY ("grn_id") REFERENCES "goods_received_note"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD CONSTRAINT "FK_43a1f13864bd720d14239d599e4" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier_line" ADD CONSTRAINT "FK_aa2dcd341edbbd44786d222c20d" FOREIGN KEY ("return_id") REFERENCES "return_to_supplier"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier_line" ADD CONSTRAINT "FK_e04c748498e30c8b5482aacd43b" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_reservation" ADD CONSTRAINT "FK_072ad2cfcf0e5a5aeb66d4a3d4a" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "store_requisition" ADD CONSTRAINT "FK_226c70e2d6c5e822d28d0c0ab42" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "store_requisition" ADD CONSTRAINT "FK_b0232fa621135f840869ee79506" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "store_requisition_line" ADD CONSTRAINT "FK_0ba5c1c21d810d91390fedbe37e" FOREIGN KEY ("requisition_id") REFERENCES "store_requisition"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "store_requisition_line" ADD CONSTRAINT "FK_b586ce8bb9344462aed740980be" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issue_voucher" ADD CONSTRAINT "FK_373300e0761edd03214c3e102c4" FOREIGN KEY ("requisition_id") REFERENCES "store_requisition"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issue_voucher" ADD CONSTRAINT "FK_d724a654480b70e800427ba7a0f" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issue_voucher" ADD CONSTRAINT "FK_746295c4c1b713c2599f9e95d59" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issue_voucher_line" ADD CONSTRAINT "FK_298c608ae38112a086fd80e9a04" FOREIGN KEY ("voucher_id") REFERENCES "issue_voucher"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issue_voucher_line" ADD CONSTRAINT "FK_cd15f8c293d7d27f479c397d8da" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "issue_voucher_line" ADD CONSTRAINT "FK_9f2dc8fe3b88f5bec18d6d607d4" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "department_return" ADD CONSTRAINT "FK_6d6b0301820c2664e90ee6b77a8" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "department_return" ADD CONSTRAINT "FK_835bdf857a7c1c25694a06a9b95" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "department_return_line" ADD CONSTRAINT "FK_9319a9ed237cc61fb90e85918c9" FOREIGN KEY ("return_id") REFERENCES "department_return"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "department_return_line" ADD CONSTRAINT "FK_31964f8281fedd79c72654f02f3" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "department_return_line" ADD CONSTRAINT "FK_9179eda32c291b569020628477d" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    /** Best effort: enum values added in up() stay (Postgres cannot drop them); supplier-return lines are folded back into jsonb. */
    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const [table, fk] of [
            ["department_return_line", "FK_9179eda32c291b569020628477d"], ["department_return_line", "FK_31964f8281fedd79c72654f02f3"],
            ["department_return_line", "FK_9319a9ed237cc61fb90e85918c9"], ["department_return", "FK_835bdf857a7c1c25694a06a9b95"],
            ["department_return", "FK_6d6b0301820c2664e90ee6b77a8"], ["issue_voucher_line", "FK_9f2dc8fe3b88f5bec18d6d607d4"],
            ["issue_voucher_line", "FK_cd15f8c293d7d27f479c397d8da"], ["issue_voucher_line", "FK_298c608ae38112a086fd80e9a04"],
            ["issue_voucher", "FK_746295c4c1b713c2599f9e95d59"], ["issue_voucher", "FK_d724a654480b70e800427ba7a0f"],
            ["issue_voucher", "FK_373300e0761edd03214c3e102c4"], ["store_requisition_line", "FK_b586ce8bb9344462aed740980be"],
            ["store_requisition_line", "FK_0ba5c1c21d810d91390fedbe37e"], ["store_requisition", "FK_b0232fa621135f840869ee79506"],
            ["store_requisition", "FK_226c70e2d6c5e822d28d0c0ab42"], ["stock_reservation", "FK_072ad2cfcf0e5a5aeb66d4a3d4a"],
            ["return_to_supplier_line", "FK_e04c748498e30c8b5482aacd43b"], ["return_to_supplier_line", "FK_aa2dcd341edbbd44786d222c20d"],
            ["return_to_supplier", "FK_43a1f13864bd720d14239d599e4"], ["return_to_supplier", "FK_99ea1c25d8cbc3cf14ecdb7dac3"],
            ["return_to_supplier", "FK_346b9f5a6500127923a0feedda6"], ["return_to_supplier", "FK_ddce1e9e684ccfd368ea9efb077"],
        ]) {
            await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${fk}"`);
        }
        await queryRunner.query(`DROP INDEX "public"."IDX_34ae8e7b668dbac7e543803e61"`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ADD "lines" jsonb NOT NULL DEFAULT '[]'::jsonb`);
        await queryRunner.query(`
            UPDATE "return_to_supplier" r SET lines = COALESCE((
              SELECT jsonb_agg(jsonb_build_object('itemId', x.item_id, 'itemName', i.name, 'batchNo', x.batch_no, 'quantity', x.quantity, 'reason', x.reason))
                FROM "return_to_supplier_line" x JOIN "item" i ON i.id = x.item_id WHERE x.return_id = r.id), '[]'::jsonb)`);
        await queryRunner.query(`DELETE FROM "return_to_supplier" WHERE grn_id IS NULL`);
        await queryRunner.query(`ALTER TABLE "return_to_supplier" ALTER COLUMN "grn_id" SET NOT NULL`);
        for (const col of ["credit_recorded_by", "credit_note_amount", "credit_note_date", "credit_note_no", "witness_id", "dispatched_at", "dispatched_by",
            "return_date", "total_value", "notes", "reason_code", "purchase_order_id", "store_id", "status", "source"]) {
            await queryRunner.query(`ALTER TABLE "return_to_supplier" DROP COLUMN "${col}"`);
        }
        await queryRunner.query(`DROP TYPE "public"."supplier_return_status"`);
        await queryRunner.query(`DROP TYPE "public"."supplier_return_source"`);
        await queryRunner.query(`DROP TABLE "return_to_supplier_line"`);
        await queryRunner.query(`DROP TABLE "return_reason"`);
        await queryRunner.query(`DROP TYPE "public"."return_reason_kind"`);
        await queryRunner.query(`DROP TABLE "department_return_line"`);
        await queryRunner.query(`DROP TYPE "public"."return_condition"`);
        await queryRunner.query(`DROP TABLE "department_return"`);
        await queryRunner.query(`DROP TYPE "public"."department_return_status"`);
        await queryRunner.query(`DROP TABLE "issue_voucher_line"`);
        await queryRunner.query(`DROP TABLE "issue_voucher"`);
        await queryRunner.query(`DROP TABLE "store_requisition_line"`);
        await queryRunner.query(`DROP TABLE "store_requisition"`);
        await queryRunner.query(`DROP TYPE "public"."store_requisition_status"`);
        await queryRunner.query(`UPDATE "stock_balance" SET reserved = 0 WHERE reserved <> 0`);
        await queryRunner.query(`DROP TABLE "stock_reservation"`);
        await queryRunner.query(`ALTER TABLE "bin" DROP COLUMN "is_quarantine"`);
        await queryRunner.query(`ALTER TABLE "approval_request" DROP COLUMN "department_id"`);
    }
}
