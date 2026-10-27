import { MigrationInterface, QueryRunner } from "typeorm";

export class NonStockPhase51762600000000 implements MigrationInterface {
    name = 'NonStockPhase51762600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "system_setting" SET "value" = "value" || '{"pettyCash.retirementReminders": "0 7 * * *"}'::jsonb WHERE "key" = 'jobs.schedules'`);
        await queryRunner.query(`CREATE TABLE "petty_cash_float" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "code" character varying(30) NOT NULL, "name" character varying(150) NOT NULL, "department_id" uuid, "location" character varying(150), "custodian_id" uuid NOT NULL, "float_limit" numeric(18,4) NOT NULL, "per_transaction_limit" numeric(18,4) NOT NULL, "replenish_threshold" numeric(18,4) NOT NULL, "gl_account_id" uuid, "mpesa_enabled" boolean NOT NULL DEFAULT false, "mpesa_shortcode" character varying(20), "balance" numeric(18,4) NOT NULL DEFAULT '0', "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_petty_cash_float" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fbcd2b263233f16187ece3190c" ON "petty_cash_float" ("code") `);
        await queryRunner.query(`CREATE TYPE "public"."petty_cash_kind" AS ENUM('PAYMENT', 'ADVANCE')`);
        await queryRunner.query(`CREATE TYPE "public"."petty_cash_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RETURNED', 'REJECTED', 'PROCESSING', 'DISBURSED', 'FAILED', 'REVIEW', 'RETIREMENT_SUBMITTED', 'RETIRED', 'REVERSED', 'CANCELLED')`);
        await queryRunner.query(`CREATE TABLE "petty_cash_request" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "float_id" uuid NOT NULL, "kind" "public"."petty_cash_kind" NOT NULL DEFAULT 'PAYMENT', "status" "public"."petty_cash_status" NOT NULL DEFAULT 'DRAFT', "requested_by" uuid NOT NULL, "payee_type" character varying(10) NOT NULL, "payee_user_id" uuid, "supplier_id" uuid, "payee_name" character varying(200) NOT NULL, "purpose" character varying(1000) NOT NULL, "gl_account_id" uuid, "department_id" uuid NOT NULL, "project_id" uuid, "amount" numeric(18,4) NOT NULL, "method" character varying(20) NOT NULL, "payee_phone" character varying(15), "payee_shortcode" character varying(20), "payee_account_ref" character varying(40), "possible_duplicate_of" uuid, "duplicate_justification" character varying(500), "disbursed_on" date, "disbursed_by" uuid, "reference" character varying(60), "received_by_name" character varying(200), "acknowledged_at" TIMESTAMP WITH TIME ZONE, "acknowledged_by" uuid, "retirement_due_on" date, "spent_amount" numeric(18,4), "refund_amount" numeric(18,4), "retirement_notes" character varying(1000), "retired_at" TIMESTAMP WITH TIME ZONE, "retired_by" uuid, "last_comment" character varying(1000), CONSTRAINT "pk_petty_cash_request" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_46d9851dcd725e26fad35eb529" ON "petty_cash_request" ("number") `);
        await queryRunner.query(`CREATE INDEX "IDX_385334dc0b128c998116724c45" ON "petty_cash_request" ("requested_by", "kind", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_cb0c69d18e2b84eb026a26cf96" ON "petty_cash_request" ("float_id", "status") `);
        await queryRunner.query(`CREATE TABLE "petty_cash_retirement_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "request_id" uuid NOT NULL, "description" character varying(300) NOT NULL, "amount" numeric(18,4) NOT NULL, "gl_account_id" uuid, "receipt_ref" character varying(60), CONSTRAINT "pk_petty_cash_retirement_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_055598f3b53a916b4bb186ecf2" ON "petty_cash_retirement_line" ("request_id") `);
        await queryRunner.query(`CREATE TYPE "public"."petty_cash_txn_type" AS ENUM('OPENING', 'REPLENISHMENT', 'DISBURSEMENT', 'REFUND', 'TOP_UP', 'REVERSAL')`);
        await queryRunner.query(`CREATE TABLE "petty_cash_transaction" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "float_id" uuid NOT NULL, "txn_date" date NOT NULL, "type" "public"."petty_cash_txn_type" NOT NULL, "amount" numeric(18,4) NOT NULL, "balance_after" numeric(18,4) NOT NULL, "ref_type" character varying(10), "ref_id" uuid, "ref_no" character varying(60), "note" character varying(500), CONSTRAINT "pk_petty_cash_transaction" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_0912df319e5d8269019c888d95" ON "petty_cash_transaction" ("float_id", "txn_date") `);
        await queryRunner.query(`CREATE TYPE "public"."replenishment_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RETURNED', 'REJECTED', 'RECEIVED', 'CANCELLED')`);
        await queryRunner.query(`CREATE TABLE "petty_cash_replenishment" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "float_id" uuid NOT NULL, "status" "public"."replenishment_status" NOT NULL DEFAULT 'DRAFT', "amount" numeric(18,4) NOT NULL, "balance_at_request" numeric(18,4) NOT NULL, "requested_by" uuid NOT NULL, "reason" character varying(500), "received_at" TIMESTAMP WITH TIME ZONE, "received_by" uuid, "reference" character varying(100), "last_comment" character varying(1000), CONSTRAINT "pk_petty_cash_replenishment" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c4ac92a262d8eee378ca0e21fa" ON "petty_cash_replenishment" ("number") `);
        await queryRunner.query(`CREATE INDEX "IDX_344affd98557f3b4e37d4045c0" ON "petty_cash_replenishment" ("float_id", "status") `);
        await queryRunner.query(`CREATE TABLE "petty_cash_count" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "float_id" uuid NOT NULL, "counted_by" uuid NOT NULL, "expected" numeric(18,4) NOT NULL, "counted" numeric(18,4) NOT NULL, "variance" numeric(18,4) NOT NULL, "notes" character varying(1000), CONSTRAINT "pk_petty_cash_count" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f422d09dcd03f2887e5f12f61b" ON "petty_cash_count" ("float_id", "created_at") `);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" ADD "petty_cash_id" uuid`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d0eaf0cc3621cba401ec57d1df"`);
        await queryRunner.query(`ALTER TYPE "public"."notification_category" RENAME TO "notification_category_old"`);
        await queryRunner.query(`CREATE TYPE "public"."notification_category" AS ENUM('REORDER', 'STOCKOUT', 'EXPIRY', 'JOBS', 'ETIMS', 'CONTRACTS', 'HMIS', 'APPROVALS', 'REQUISITIONS', 'PAYMENTS', 'PETTY_CASH')`);
        await queryRunner.query(`ALTER TABLE "notification_preference" ALTER COLUMN "category" TYPE "public"."notification_category" USING "category"::"text"::"public"."notification_category"`);
        await queryRunner.query(`DROP TYPE "public"."notification_category_old"`);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" DROP CONSTRAINT "FK_11f8d13c5cd2e54569b14a890a8"`);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" ALTER COLUMN "voucher_id" DROP NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d0eaf0cc3621cba401ec57d1df" ON "notification_preference" ("user_id", "category") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_mpesa_payout_live_petty_cash" ON "mpesa_payout" ("petty_cash_id") WHERE status IN ('PENDING', 'UNKNOWN', 'SUCCESS')`);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" ADD CONSTRAINT "ck_mpesa_payout_one_owner" CHECK ((voucher_id IS NULL) <> (petty_cash_id IS NULL))`);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" ADD CONSTRAINT "FK_11f8d13c5cd2e54569b14a890a8" FOREIGN KEY ("voucher_id") REFERENCES "payment_voucher"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "petty_cash_float" ADD CONSTRAINT "FK_9e620a1b1c6e8a572bf5aad86d2" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "petty_cash_float" ADD CONSTRAINT "FK_a3f560ad7171deaf265f589a389" FOREIGN KEY ("gl_account_id") REFERENCES "gl_account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "petty_cash_request" ADD CONSTRAINT "FK_897a823182888124371311f86c3" FOREIGN KEY ("float_id") REFERENCES "petty_cash_float"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "petty_cash_request" ADD CONSTRAINT "FK_dadccdf146d0ae67892bc09e234" FOREIGN KEY ("gl_account_id") REFERENCES "gl_account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "petty_cash_request" ADD CONSTRAINT "FK_1e7f63474141f2dcbc0dc4a4b80" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "petty_cash_retirement_line" ADD CONSTRAINT "FK_055598f3b53a916b4bb186ecf26" FOREIGN KEY ("request_id") REFERENCES "petty_cash_request"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "petty_cash_replenishment" ADD CONSTRAINT "FK_52d7ec9cc7421a8062727d1d84b" FOREIGN KEY ("float_id") REFERENCES "petty_cash_float"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "system_setting" SET "value" = "value" - 'pettyCash.retirementReminders' WHERE "key" = 'jobs.schedules'`);
        await queryRunner.query(`ALTER TABLE "petty_cash_replenishment" DROP CONSTRAINT "FK_52d7ec9cc7421a8062727d1d84b"`);
        await queryRunner.query(`ALTER TABLE "petty_cash_retirement_line" DROP CONSTRAINT "FK_055598f3b53a916b4bb186ecf26"`);
        await queryRunner.query(`ALTER TABLE "petty_cash_request" DROP CONSTRAINT "FK_1e7f63474141f2dcbc0dc4a4b80"`);
        await queryRunner.query(`ALTER TABLE "petty_cash_request" DROP CONSTRAINT "FK_dadccdf146d0ae67892bc09e234"`);
        await queryRunner.query(`ALTER TABLE "petty_cash_request" DROP CONSTRAINT "FK_897a823182888124371311f86c3"`);
        await queryRunner.query(`ALTER TABLE "petty_cash_float" DROP CONSTRAINT "FK_a3f560ad7171deaf265f589a389"`);
        await queryRunner.query(`ALTER TABLE "petty_cash_float" DROP CONSTRAINT "FK_9e620a1b1c6e8a572bf5aad86d2"`);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" DROP CONSTRAINT "FK_11f8d13c5cd2e54569b14a890a8"`);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" DROP CONSTRAINT "ck_mpesa_payout_one_owner"`);
        await queryRunner.query(`DROP INDEX "public"."uq_mpesa_payout_live_petty_cash"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d0eaf0cc3621cba401ec57d1df"`);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" ALTER COLUMN "voucher_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" ADD CONSTRAINT "FK_11f8d13c5cd2e54569b14a890a8" FOREIGN KEY ("voucher_id") REFERENCES "payment_voucher"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE TYPE "public"."notification_category_old" AS ENUM('APPROVALS', 'CONTRACTS', 'ETIMS', 'EXPIRY', 'HMIS', 'JOBS', 'PAYMENTS', 'REORDER', 'REQUISITIONS', 'STOCKOUT')`);
        await queryRunner.query(`ALTER TABLE "notification_preference" ALTER COLUMN "category" TYPE "public"."notification_category_old" USING "category"::"text"::"public"."notification_category_old"`);
        await queryRunner.query(`DROP TYPE "public"."notification_category"`);
        await queryRunner.query(`ALTER TYPE "public"."notification_category_old" RENAME TO "notification_category"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d0eaf0cc3621cba401ec57d1df" ON "notification_preference" ("user_id", "category") `);
        await queryRunner.query(`ALTER TABLE "mpesa_payout" DROP COLUMN "petty_cash_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f422d09dcd03f2887e5f12f61b"`);
        await queryRunner.query(`DROP TABLE "petty_cash_count"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_344affd98557f3b4e37d4045c0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c4ac92a262d8eee378ca0e21fa"`);
        await queryRunner.query(`DROP TABLE "petty_cash_replenishment"`);
        await queryRunner.query(`DROP TYPE "public"."replenishment_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0912df319e5d8269019c888d95"`);
        await queryRunner.query(`DROP TABLE "petty_cash_transaction"`);
        await queryRunner.query(`DROP TYPE "public"."petty_cash_txn_type"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_055598f3b53a916b4bb186ecf2"`);
        await queryRunner.query(`DROP TABLE "petty_cash_retirement_line"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cb0c69d18e2b84eb026a26cf96"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_385334dc0b128c998116724c45"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_46d9851dcd725e26fad35eb529"`);
        await queryRunner.query(`DROP TABLE "petty_cash_request"`);
        await queryRunner.query(`DROP TYPE "public"."petty_cash_status"`);
        await queryRunner.query(`DROP TYPE "public"."petty_cash_kind"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fbcd2b263233f16187ece3190c"`);
        await queryRunner.query(`DROP TABLE "petty_cash_float"`);
    }

}
