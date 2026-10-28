import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Go-live hardening: indexes on the foreign keys documents are looked up by
 * (lines by their header, invoices / GRNs / certificates by their order,
 * vouchers by their invoice, orders by their RFQ / requisition, approvals by
 * their document…), and the (supplier, order date) / (requester, created) pairs
 * the split-request and duplicate-payment checks look up. Found by the load test (51k orders, 69k
 * invoices): without them the order register and several reports scanned
 * every line once per document.
 */
export class GoLiveIndexes1762800000000 implements MigrationInterface {
    name = "GoLiveIndexes1762800000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_b8b941286b93ff9eaedb77405a" ON "petty_cash_request" ("amount", "disbursed_on") `);
        await queryRunner.query(`CREATE INDEX "IDX_51cfea0b6af95cda7353dd89a1" ON "approval_request" ("document_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ce198a89f67337f0a19eb082dc" ON "approval_action" ("user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_747d20f25aa7fd0655a378ca6a" ON "purchase_requisition_line" ("requisition_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_fe1c7eddde74d266d0f44001b1" ON "rfq" ("requisition_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_3fae9de509412d72b09e9e3c95" ON "rfq_line" ("rfq_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_673524ac1d56bd225b0a316055" ON "rfq_line" ("requisition_line_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5e2087bb44abe6aa360fc3bb46" ON "quotation_line" ("rfq_line_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5d29b148d3b6565e056fe2151e" ON "purchase_order" ("supplier_id", "order_date") `);
        await queryRunner.query(`CREATE INDEX "IDX_38991eb8dd181a7d35240ec41a" ON "purchase_order" ("rfq_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_f7ad6591d5b8bd892da912c417" ON "purchase_order" ("requisition_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5d8c68b77890a17d89746f2f86" ON "purchase_order_line" ("purchase_order_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_b1a53331c2f8280eacd42c1de1" ON "purchase_order_line" ("item_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_db6db8727b2d63a4f30de1fb1d" ON "purchase_order_line" ("requisition_line_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_d0fa6f9a0ee376304659b9918f" ON "purchase_order_line" ("rfq_line_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ad1b83c41c825ed0c053d03f19" ON "goods_received_note" ("purchase_order_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_9b94ee103ba95d2e00e4a40450" ON "goods_received_note" ("supplier_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_fcca891070b2bb8051340510f3" ON "grn_line" ("grn_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5e2a249455a2cb7f70e7d8bc67" ON "grn_line" ("po_line_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_21a9f5d1d5237398f7b126bd62" ON "supplier_invoice" ("purchase_order_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_19bb962e5f7e10bddf267f93a0" ON "supplier_invoice_line" ("invoice_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_77da3b97fd8c0111b6388f6234" ON "supplier_invoice_line" ("po_line_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_c57b4c7982d26da6561f4b22df" ON "payment_voucher" ("invoice_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_377f42ae96ca6314809e917d1c" ON "payment_voucher_line" ("voucher_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_b419588b8afa2a89058460173a" ON "staff_requisition" ("requested_by", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_db9922625ae0d8565c95d3bc39" ON "staff_requisition_line" ("pr_line_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_c47a9c8e029ab8dcb7fc099bbb" ON "handover_line" ("handover_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_55e60c411c1b2fbacdb5853611" ON "handover_line" ("requisition_line_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8df789ff3bd978fb19abc6e1cc" ON "service_certificate" ("purchase_order_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_0e4ae670b42f4e5779104713a1" ON "service_certificate_line" ("certificate_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5b40cb1f2271f9eaa2160b1c46" ON "service_certificate_line" ("po_line_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_494975e0b0bcf97640cfde7bca" ON "petty_cash_request" ("requested_by", "created_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_494975e0b0bcf97640cfde7bca"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5b40cb1f2271f9eaa2160b1c46"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0e4ae670b42f4e5779104713a1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8df789ff3bd978fb19abc6e1cc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_55e60c411c1b2fbacdb5853611"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c47a9c8e029ab8dcb7fc099bbb"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_db9922625ae0d8565c95d3bc39"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b419588b8afa2a89058460173a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_377f42ae96ca6314809e917d1c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c57b4c7982d26da6561f4b22df"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_77da3b97fd8c0111b6388f6234"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_19bb962e5f7e10bddf267f93a0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_21a9f5d1d5237398f7b126bd62"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5e2a249455a2cb7f70e7d8bc67"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fcca891070b2bb8051340510f3"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9b94ee103ba95d2e00e4a40450"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ad1b83c41c825ed0c053d03f19"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d0fa6f9a0ee376304659b9918f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_db6db8727b2d63a4f30de1fb1d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b1a53331c2f8280eacd42c1de1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5d8c68b77890a17d89746f2f86"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f7ad6591d5b8bd892da912c417"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_38991eb8dd181a7d35240ec41a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5d29b148d3b6565e056fe2151e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5e2087bb44abe6aa360fc3bb46"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_673524ac1d56bd225b0a316055"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3fae9de509412d72b09e9e3c95"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fe1c7eddde74d266d0f44001b1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_747d20f25aa7fd0655a378ca6a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ce198a89f67337f0a19eb082dc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_51cfea0b6af95cda7353dd89a1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b8b941286b93ff9eaedb77405a"`);
    }
}
