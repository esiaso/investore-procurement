import { MigrationInterface, QueryRunner } from "typeorm";

export class NonStockPhase31762400000000 implements MigrationInterface {
    name = 'NonStockPhase31762400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."handover_status" AS ENUM('PENDING', 'ACKNOWLEDGED', 'CANCELLED')`);
        await queryRunner.query(`CREATE TYPE "public"."item_condition" AS ENUM('GOOD', 'DAMAGED', 'INCOMPLETE')`);
        await queryRunner.query(`CREATE TYPE "public"."handover_channel" AS ENUM('IN_APP', 'OTP')`);
        await queryRunner.query(`CREATE TABLE "handover" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "number" character varying(60) NOT NULL, "requisition_id" uuid NOT NULL, "status" "public"."handover_status" NOT NULL DEFAULT 'PENDING', "prepared_by" uuid NOT NULL, "received_by" uuid NOT NULL, "condition" "public"."item_condition" NOT NULL DEFAULT 'GOOD', "notes" character varying(1000), "ack_channel" "public"."handover_channel", "acknowledged_at" TIMESTAMP WITH TIME ZONE, "ack_comment" character varying(1000), "ack_ip" character varying(64), "otp_hash" character varying(64), "otp_expires_at" TIMESTAMP WITH TIME ZONE, "otp_attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "pk_handover" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7964f3489de65f895c1322e332" ON "handover" ("number") `);
        await queryRunner.query(`CREATE INDEX "IDX_7769943a4806322cf3bbc59d69" ON "handover" ("received_by", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_8471343f50f4d77aea4839904d" ON "handover" ("requisition_id") `);
        await queryRunner.query(`CREATE TABLE "handover_line" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "handover_id" uuid NOT NULL, "requisition_line_id" uuid NOT NULL, "quantity" numeric(18,4) NOT NULL, "remarks" character varying(500), CONSTRAINT "pk_handover_line" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" ADD "currency" character varying(3) NOT NULL DEFAULT 'KES'`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" ADD "exchange_rate" numeric(18,6) NOT NULL DEFAULT '1'`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" ADD "base_total" numeric(18,4) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" ADD "wht_total" numeric(18,4) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice_line" ADD "wht_amount" numeric(18,4) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "staff_requisition_line" ADD "received_qty" numeric(18,4) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "staff_requisition_line" ADD "delivered_qty" numeric(18,4) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "service_certificate" ADD "accepted_by" uuid`);
        await queryRunner.query(`ALTER TABLE "service_certificate" ADD "rejection_reason" character varying(1000)`);
        await queryRunner.query(`ALTER TABLE "service_certificate_line" ADD "rejected_qty" numeric(18,4) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "service_certificate_line" ADD "rejection_reason" character varying(500)`);
        await queryRunner.query(`ALTER TYPE "public"."invoice_status" RENAME TO "invoice_status_old"`);
        await queryRunner.query(`CREATE TYPE "public"."invoice_status" AS ENUM('CAPTURED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'SCHEDULED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED')`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" ALTER COLUMN "status" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" ALTER COLUMN "status" TYPE "public"."invoice_status" USING "status"::"text"::"public"."invoice_status"`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" ALTER COLUMN "status" SET DEFAULT 'CAPTURED'`);
        await queryRunner.query(`DROP TYPE "public"."invoice_status_old"`);
        await queryRunner.query(`ALTER TYPE "public"."certificate_status" RENAME TO "certificate_status_old"`);
        await queryRunner.query(`CREATE TYPE "public"."certificate_status" AS ENUM('DRAFT', 'POSTED', 'REJECTED', 'CANCELLED')`);
        await queryRunner.query(`ALTER TABLE "service_certificate" ALTER COLUMN "status" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "service_certificate" ALTER COLUMN "status" TYPE "public"."certificate_status" USING "status"::"text"::"public"."certificate_status"`);
        await queryRunner.query(`ALTER TABLE "service_certificate" ALTER COLUMN "status" SET DEFAULT 'DRAFT'`);
        await queryRunner.query(`DROP TYPE "public"."certificate_status_old"`);
        // Existing invoices: in their order's currency and rate.
        await queryRunner.query(`UPDATE "supplier_invoice" i SET "currency" = po."currency", "exchange_rate" = po."exchange_rate", "base_total" = ROUND(i."total" * po."exchange_rate", 2) FROM "purchase_order" po WHERE po."id" = i."purchase_order_id"`);
        // Non-stock lines already accepted on posted certificates count as received for their requisitions.
        await queryRunner.query(`UPDATE "staff_requisition_line" sl SET "received_qty" = LEAST(sl."quantity", x.q)
            FROM (SELECT pl."id" AS pr_line_id, SUM(cl."quantity") AS q FROM "service_certificate_line" cl JOIN "service_certificate" c ON c."id" = cl."certificate_id" AND c."status" = 'POSTED'
                    JOIN "purchase_order_line" ol ON ol."id" = cl."po_line_id" JOIN "purchase_requisition_line" pl ON pl."id" = ol."requisition_line_id" GROUP BY pl."id") x
           WHERE sl."pr_line_id" = x.pr_line_id`);
        await queryRunner.query(`ALTER TABLE "handover" ADD CONSTRAINT "FK_8471343f50f4d77aea4839904d1" FOREIGN KEY ("requisition_id") REFERENCES "staff_requisition"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "handover_line" ADD CONSTRAINT "FK_c47a9c8e029ab8dcb7fc099bbbb" FOREIGN KEY ("handover_id") REFERENCES "handover"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "handover_line" ADD CONSTRAINT "FK_55e60c411c1b2fbacdb5853611c" FOREIGN KEY ("requisition_line_id") REFERENCES "staff_requisition_line"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "handover_line" DROP CONSTRAINT "FK_55e60c411c1b2fbacdb5853611c"`);
        await queryRunner.query(`ALTER TABLE "handover_line" DROP CONSTRAINT "FK_c47a9c8e029ab8dcb7fc099bbbb"`);
        await queryRunner.query(`ALTER TABLE "handover" DROP CONSTRAINT "FK_8471343f50f4d77aea4839904d1"`);
        await queryRunner.query(`CREATE TYPE "public"."certificate_status_old" AS ENUM('DRAFT', 'POSTED', 'CANCELLED')`);
        await queryRunner.query(`ALTER TABLE "service_certificate" ALTER COLUMN "status" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "service_certificate" ALTER COLUMN "status" TYPE "public"."certificate_status_old" USING "status"::"text"::"public"."certificate_status_old"`);
        await queryRunner.query(`ALTER TABLE "service_certificate" ALTER COLUMN "status" SET DEFAULT 'DRAFT'`);
        await queryRunner.query(`DROP TYPE "public"."certificate_status"`);
        await queryRunner.query(`ALTER TYPE "public"."certificate_status_old" RENAME TO "certificate_status"`);
        await queryRunner.query(`CREATE TYPE "public"."invoice_status_old" AS ENUM('CAPTURED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'PAID', 'CANCELLED')`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" ALTER COLUMN "status" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" ALTER COLUMN "status" TYPE "public"."invoice_status_old" USING "status"::"text"::"public"."invoice_status_old"`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" ALTER COLUMN "status" SET DEFAULT 'CAPTURED'`);
        await queryRunner.query(`DROP TYPE "public"."invoice_status"`);
        await queryRunner.query(`ALTER TYPE "public"."invoice_status_old" RENAME TO "invoice_status"`);
        await queryRunner.query(`ALTER TABLE "service_certificate_line" DROP COLUMN "rejection_reason"`);
        await queryRunner.query(`ALTER TABLE "service_certificate_line" DROP COLUMN "rejected_qty"`);
        await queryRunner.query(`ALTER TABLE "service_certificate" DROP COLUMN "rejection_reason"`);
        await queryRunner.query(`ALTER TABLE "service_certificate" DROP COLUMN "accepted_by"`);
        await queryRunner.query(`ALTER TABLE "staff_requisition_line" DROP COLUMN "delivered_qty"`);
        await queryRunner.query(`ALTER TABLE "staff_requisition_line" DROP COLUMN "received_qty"`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice_line" DROP COLUMN "wht_amount"`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" DROP COLUMN "wht_total"`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" DROP COLUMN "base_total"`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" DROP COLUMN "exchange_rate"`);
        await queryRunner.query(`ALTER TABLE "supplier_invoice" DROP COLUMN "currency"`);
        await queryRunner.query(`DROP TABLE "handover_line"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8471343f50f4d77aea4839904d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7769943a4806322cf3bbc59d69"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7964f3489de65f895c1322e332"`);
        await queryRunner.query(`DROP TABLE "handover"`);
        await queryRunner.query(`DROP TYPE "public"."handover_channel"`);
        await queryRunner.query(`DROP TYPE "public"."item_condition"`);
        await queryRunner.query(`DROP TYPE "public"."handover_status"`);
    }

}
