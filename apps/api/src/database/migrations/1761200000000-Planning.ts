import { MigrationInterface, QueryRunner } from "typeorm";

export class Planning1761200000000 implements MigrationInterface {
    name = 'Planning1761200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."notification_category" AS ENUM('REORDER', 'STOCKOUT', 'EXPIRY', 'JOBS')`);
        await queryRunner.query(`CREATE TABLE "notification_preference" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "user_id" uuid NOT NULL, "category" "public"."notification_category" NOT NULL, "in_app" boolean NOT NULL DEFAULT true, "email" boolean NOT NULL DEFAULT true, "sms" boolean NOT NULL DEFAULT false, CONSTRAINT "pk_notification_preference" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d0eaf0cc3621cba401ec57d1df" ON "notification_preference" ("user_id", "category") `);
        await queryRunner.query(`CREATE TYPE "public"."job_run_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED')`);
        await queryRunner.query(`CREATE TABLE "job_run" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(60) NOT NULL, "status" "public"."job_run_status" NOT NULL, "trigger" character varying(20) NOT NULL, "params" jsonb NOT NULL DEFAULT '{}'::jsonb, "result" jsonb, "error" character varying(2000), "user_id" uuid, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "pk_job_run" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_499e2a81304d11ead831a0ce13" ON "job_run" ("name", "started_at") `);
        await queryRunner.query(`CREATE TYPE "public"."stock_setting_mode" AS ENUM('AUTO', 'MANUAL')`);
        await queryRunner.query(`CREATE TABLE "store_item_setting" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "store_id" uuid NOT NULL, "item_id" uuid NOT NULL, "mode" "public"."stock_setting_mode" NOT NULL DEFAULT 'AUTO', "min_level" numeric(18,4) NOT NULL DEFAULT '0', "max_level" numeric(18,4) NOT NULL DEFAULT '0', "reorder_level" numeric(18,4) NOT NULL DEFAULT '0', "reorder_qty" numeric(18,4) NOT NULL DEFAULT '0', "safety_stock" numeric(18,4) NOT NULL DEFAULT '0', "lead_time_days" integer, "review_period_days" integer, "amc" numeric(18,4) NOT NULL DEFAULT '0', "amc_calculated_at" TIMESTAMP WITH TIME ZONE, "amc_days" integer, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "pk_store_item_setting" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c7f00dc0cd2e5411365df08f14" ON "store_item_setting" ("store_id", "item_id") `);
        await queryRunner.query(`CREATE TYPE "public"."stock_alert_type" AS ENUM('REORDER', 'STOCKOUT', 'NEAR_EXPIRY', 'EXPIRED')`);
        await queryRunner.query(`CREATE TYPE "public"."stock_alert_status" AS ENUM('OPEN', 'RESOLVED')`);
        await queryRunner.query(`CREATE TABLE "stock_alert" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" "public"."stock_alert_type" NOT NULL, "status" "public"."stock_alert_status" NOT NULL DEFAULT 'OPEN', "dedupe_key" character varying(200) NOT NULL, "store_id" uuid NOT NULL, "item_id" uuid NOT NULL, "batch_id" uuid, "horizon_days" integer, "message" character varying(300) NOT NULL, "details" jsonb NOT NULL DEFAULT '{}'::jsonb, "value" numeric(20,4), "raised_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "resolved_at" TIMESTAMP WITH TIME ZONE, "notified_count" integer NOT NULL DEFAULT '0', CONSTRAINT "pk_stock_alert" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_stock_alert_dedupe" ON "stock_alert" ("dedupe_key") `);
        await queryRunner.query(`CREATE INDEX "IDX_97fa04e05b083b91adefd7630f" ON "stock_alert" ("status", "type", "store_id") `);
        await queryRunner.query(`ALTER TABLE "item_category" ADD "expiry_alert_days" integer array`);
        await queryRunner.query(`ALTER TABLE "store_item_setting" ADD CONSTRAINT "FK_72ac1d747d8be0bdf6b559acda0" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "store_item_setting" ADD CONSTRAINT "FK_12b0cc5f308ee3586b4b75e9b0b" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_alert" ADD CONSTRAINT "FK_5930f9ceeb36ece021fd134c098" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_alert" ADD CONSTRAINT "FK_c88bc83ce7a6885bcc679d8df5f" FOREIGN KEY ("item_id") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "stock_alert" ADD CONSTRAINT "FK_014970459c527d0ad65de4af082" FOREIGN KEY ("batch_id") REFERENCES "batch"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stock_alert" DROP CONSTRAINT "FK_014970459c527d0ad65de4af082"`);
        await queryRunner.query(`ALTER TABLE "stock_alert" DROP CONSTRAINT "FK_c88bc83ce7a6885bcc679d8df5f"`);
        await queryRunner.query(`ALTER TABLE "stock_alert" DROP CONSTRAINT "FK_5930f9ceeb36ece021fd134c098"`);
        await queryRunner.query(`ALTER TABLE "store_item_setting" DROP CONSTRAINT "FK_12b0cc5f308ee3586b4b75e9b0b"`);
        await queryRunner.query(`ALTER TABLE "store_item_setting" DROP CONSTRAINT "FK_72ac1d747d8be0bdf6b559acda0"`);
        await queryRunner.query(`ALTER TABLE "item_category" DROP COLUMN "expiry_alert_days"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_97fa04e05b083b91adefd7630f"`);
        await queryRunner.query(`DROP INDEX "public"."uq_stock_alert_dedupe"`);
        await queryRunner.query(`DROP TABLE "stock_alert"`);
        await queryRunner.query(`DROP TYPE "public"."stock_alert_status"`);
        await queryRunner.query(`DROP TYPE "public"."stock_alert_type"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c7f00dc0cd2e5411365df08f14"`);
        await queryRunner.query(`DROP TABLE "store_item_setting"`);
        await queryRunner.query(`DROP TYPE "public"."stock_setting_mode"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_499e2a81304d11ead831a0ce13"`);
        await queryRunner.query(`DROP TABLE "job_run"`);
        await queryRunner.query(`DROP TYPE "public"."job_run_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d0eaf0cc3621cba401ec57d1df"`);
        await queryRunner.query(`DROP TABLE "notification_preference"`);
        await queryRunner.query(`DROP TYPE "public"."notification_category"`);
    }

}
