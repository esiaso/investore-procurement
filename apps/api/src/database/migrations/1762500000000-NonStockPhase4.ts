import { MigrationInterface, QueryRunner } from "typeorm";

export class NonStockPhase41762500000000 implements MigrationInterface {
    name = 'NonStockPhase41762500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "payment_voucher_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "voucher_id" uuid NOT NULL, "invoice_id" uuid NOT NULL, "amount" numeric(18,4) NOT NULL, "wht_amount" numeric(18,4) NOT NULL DEFAULT '0', "net_amount" numeric(18,4) NOT NULL, CONSTRAINT "pk_payment_voucher_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f1c8da3b6c1295489c32b51cdb" ON "payment_voucher_line" ("invoice_id") `);
        await queryRunner.query(`CREATE TYPE "public"."payout_attempt_status" AS ENUM('PENDING', 'UNKNOWN', 'SUCCESS', 'FAILED', 'REVERSED')`);
        await queryRunner.query(`CREATE TABLE "mpesa_payout" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "voucher_id" uuid NOT NULL, "attempt" integer NOT NULL, "command_id" character varying(40) NOT NULL, "originator_conversation_id" character varying(100) NOT NULL, "conversation_id" character varying(100), "party_b" character varying(20) NOT NULL, "account_ref" character varying(40), "amount" numeric(18,4) NOT NULL, "status" "public"."payout_attempt_status" NOT NULL DEFAULT 'PENDING', "result_code" character varying(20), "result_desc" character varying(500), "receipt_no" character varying(30), "charges" numeric(18,4), "recipient_name" character varying(200), "completed_at" TIMESTAMP WITH TIME ZONE, "request_body" jsonb, "response_body" jsonb, "result_body" jsonb, "status_checks" integer NOT NULL DEFAULT '0', "next_check_at" TIMESTAMP WITH TIME ZONE, "released_by" uuid, "reversal_body" jsonb, "reversed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_mpesa_payout" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6680ff91fad828e1696e729a3d" ON "mpesa_payout" ("originator_conversation_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_6611c0e748293005b72a997b59" ON "mpesa_payout" ("conversation_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2f8008e5990f32882711ce0efc" ON "mpesa_payout" ("receipt_no") WHERE "receipt_no" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_8083cec2947a8b25a6c754dcb4" ON "mpesa_payout" ("status", "next_check_at") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_mpesa_payout_live_voucher" ON "mpesa_payout" ("voucher_id") WHERE status IN ('PENDING', 'UNKNOWN', 'SUCCESS')`);
        await queryRunner.query(`CREATE TABLE "mpesa_statement_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "receipt_no" character varying(30) NOT NULL, "completed_at" TIMESTAMP WITH TIME ZONE NOT NULL, "details" character varying(500), "withdrawn" numeric(18,4) NOT NULL DEFAULT '0', "paid_in" numeric(18,4) NOT NULL DEFAULT '0', "imported_by" uuid, CONSTRAINT "pk_mpesa_statement_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f4675966e10402bba1f2b0c5bd" ON "mpesa_statement_line" ("receipt_no") `);
        await queryRunner.query(`CREATE INDEX "IDX_b97dc79a2ebb28482a8e84f0d1" ON "mpesa_statement_line" ("completed_at") `);
        await queryRunner.query(`CREATE TYPE "public"."reconciliation_status" AS ENUM('MATCHED', 'EXCEPTIONS')`);
        await queryRunner.query(`CREATE TABLE "payment_reconciliation" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "date_from" date NOT NULL, "date_to" date NOT NULL, "status" "public"."reconciliation_status" NOT NULL, "matched" integer NOT NULL DEFAULT '0', "system_total" numeric(18,4) NOT NULL, "statement_total" numeric(18,4) NOT NULL, "exceptions" jsonb NOT NULL DEFAULT '[]'::jsonb, "account_balance" numeric(18,4), "run_by" uuid, CONSTRAINT "pk_payment_reconciliation" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_44ce209dc2ebd047010eeb225c" ON "payment_reconciliation" ("date_from", "date_to") `);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" ADD "paid_amount" numeric(18,4) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "supplier_id" uuid`);
        await queryRunner.query(`CREATE TYPE "public"."payment_voucher_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RETURNED', 'REJECTED', 'PROCESSING', 'PAID', 'FAILED', 'REVIEW', 'REVERSED', 'CANCELLED')`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "status" "public"."payment_voucher_status" NOT NULL DEFAULT 'DRAFT'`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "currency" character varying(3) NOT NULL DEFAULT 'KES'`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "gross_amount" numeric(18,4) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "wht_amount" numeric(18,4) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "due_date" date`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "payee_name" character varying(200)`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "payee_phone" character varying(15)`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "payee_shortcode" character varying(20)`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "payee_account_ref" character varying(40)`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "narrative" character varying(500)`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "prepared_by" uuid`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "released_by" uuid`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "released_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD "last_comment" character varying(1000)`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d0eaf0cc3621cba401ec57d1df"`);
        await queryRunner.query(`ALTER TYPE "public"."notification_category" RENAME TO "notification_category_old"`);
        await queryRunner.query(`CREATE TYPE "public"."notification_category" AS ENUM('REORDER', 'STOCKOUT', 'EXPIRY', 'JOBS', 'ETIMS', 'CONTRACTS', 'HMIS', 'APPROVALS', 'REQUISITIONS', 'PAYMENTS')`);
        await queryRunner.query(`ALTER TABLE "notification_preference" ALTER COLUMN "category" TYPE "public"."notification_category" USING "category"::"text"::"public"."notification_category"`);
        await queryRunner.query(`DROP TYPE "public"."notification_category_old"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP CONSTRAINT "FK_c57b4c7982d26da6561f4b22dfe"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ALTER COLUMN "invoice_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ALTER COLUMN "paid_on" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ALTER COLUMN "payment_reference" DROP NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d0eaf0cc3621cba401ec57d1df" ON "notification_preference" ("user_id", "category") `);
        // Vouchers from before batching: paid, one line for their invoice.
        await queryRunner.query(`UPDATE "payment_voucher" pv SET "status" = 'PAID', "supplier_id" = si."supplier_id", "currency" = si."currency", "gross_amount" = pv."amount", "prepared_by" = NULL FROM "supplier_invoice" si WHERE si."id" = pv."invoice_id"`);
        await queryRunner.query(`INSERT INTO "payment_voucher_line" ("voucher_id", "invoice_id", "amount", "wht_amount", "net_amount") SELECT "id", "invoice_id", "amount", 0, "amount" FROM "payment_voucher" WHERE "invoice_id" IS NOT NULL`);
        await queryRunner.query(`UPDATE "supplier_invoice" SET "paid_amount" = "total" WHERE "status" = 'PAID'`);
        await queryRunner.query(`UPDATE "system_setting" SET "value" = "value" || '{"payments.mpesaFollowUp": "*/5 * * * *", "payments.mpesaReconcile": "0 6 * * *"}'::jsonb WHERE "key" = 'jobs.schedules'`);
        await queryRunner.query(`CREATE INDEX "IDX_dce2f40178ee47c3592d5f4c2e" ON "payment_voucher" ("supplier_id", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_db1552c3e360649678a7db8a78" ON "payment_voucher" ("status", "due_date") `);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD CONSTRAINT "FK_c57b4c7982d26da6561f4b22dfe" FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoice"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD CONSTRAINT "FK_f9bab817a57db965460f86a1b73" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_voucher_line" ADD CONSTRAINT "FK_377f42ae96ca6314809e917d1c2" FOREIGN KEY ("voucher_id") REFERENCES "payment_voucher"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_voucher_line" ADD CONSTRAINT "FK_f1c8da3b6c1295489c32b51cdb1" FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoice"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" ADD CONSTRAINT "FK_11f8d13c5cd2e54569b14a890a8" FOREIGN KEY ("voucher_id") REFERENCES "payment_voucher"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "system_setting" SET "value" = "value" - 'payments.mpesaFollowUp' - 'payments.mpesaReconcile' WHERE "key" = 'jobs.schedules'`);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" DROP CONSTRAINT "FK_11f8d13c5cd2e54569b14a890a8"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher_line" DROP CONSTRAINT "FK_f1c8da3b6c1295489c32b51cdb1"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher_line" DROP CONSTRAINT "FK_377f42ae96ca6314809e917d1c2"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP CONSTRAINT "FK_f9bab817a57db965460f86a1b73"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP CONSTRAINT "FK_c57b4c7982d26da6561f4b22dfe"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_db1552c3e360649678a7db8a78"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dce2f40178ee47c3592d5f4c2e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d0eaf0cc3621cba401ec57d1df"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ALTER COLUMN "payment_reference" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ALTER COLUMN "paid_on" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ALTER COLUMN "invoice_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" ADD CONSTRAINT "FK_c57b4c7982d26da6561f4b22dfe" FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoice"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE TYPE "public"."notification_category_old" AS ENUM('REORDER', 'STOCKOUT', 'EXPIRY', 'JOBS', 'ETIMS', 'CONTRACTS', 'HMIS', 'APPROVALS', 'REQUISITIONS')`);
        await queryRunner.query(`ALTER TABLE "notification_preference" ALTER COLUMN "category" TYPE "public"."notification_category_old" USING "category"::"text"::"public"."notification_category_old"`);
        await queryRunner.query(`DROP TYPE "public"."notification_category"`);
        await queryRunner.query(`ALTER TYPE "public"."notification_category_old" RENAME TO "notification_category"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d0eaf0cc3621cba401ec57d1df" ON "notification_preference" ("user_id", "category") `);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "last_comment"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "released_at"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "released_by"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "prepared_by"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "narrative"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "payee_account_ref"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "payee_shortcode"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "payee_phone"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "payee_name"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "due_date"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "wht_amount"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "gross_amount"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "currency"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "status"`);
        await queryRunner.query(`DROP TYPE "public"."payment_voucher_status"`);
        await queryRunner.query(`ALTER TABLE "payment_voucher" DROP COLUMN "supplier_id"`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" DROP COLUMN "paid_amount"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_44ce209dc2ebd047010eeb225c"`);
        await queryRunner.query(`DROP TABLE "payment_reconciliation"`);
        await queryRunner.query(`DROP TYPE "public"."reconciliation_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b97dc79a2ebb28482a8e84f0d1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f4675966e10402bba1f2b0c5bd"`);
        await queryRunner.query(`DROP TABLE "mpesa_statement_line"`);
        await queryRunner.query(`DROP INDEX "public"."uq_mpesa_payout_live_voucher"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8083cec2947a8b25a6c754dcb4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2f8008e5990f32882711ce0efc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6611c0e748293005b72a997b59"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6680ff91fad828e1696e729a3d"`);
        await queryRunner.query(`DROP TABLE "mpesa_payout"`);
        await queryRunner.query(`DROP TYPE "public"."payout_attempt_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f1c8da3b6c1295489c32b51cdb"`);
        await queryRunner.query(`DROP TABLE "payment_voucher_line"`);
    }

}
