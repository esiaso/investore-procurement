import { MigrationInterface, QueryRunner } from "typeorm";

export class Reports1762100000000 implements MigrationInterface {
    name = 'Reports1762100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."report_period" AS ENUM('YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'LAST_WEEK', 'LAST_MONTH', 'MONTH_TO_DATE')`);
        await queryRunner.query(`CREATE TYPE "public"."report_format" AS ENUM('csv', 'xlsx', 'pdf')`);
        await queryRunner.query(`CREATE TYPE "public"."report_frequency" AS ENUM('DAILY', 'WEEKLY', 'MONTHLY')`);
        await queryRunner.query(`CREATE TABLE "report_schedule" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by" uuid, "updated_by" uuid, "name" character varying(200) NOT NULL, "report_key" character varying(60) NOT NULL, "filters" jsonb NOT NULL DEFAULT '{}'::jsonb, "period" "public"."report_period" NOT NULL DEFAULT 'LAST_7_DAYS', "format" "public"."report_format" NOT NULL DEFAULT 'xlsx', "frequency" "public"."report_frequency" NOT NULL, "hour" smallint NOT NULL DEFAULT '7', "weekday" smallint, "month_day" smallint, "recipients" jsonb NOT NULL DEFAULT '[]'::jsonb, "owner_id" uuid NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "next_run_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_run_at" TIMESTAMP WITH TIME ZONE, "last_error" character varying(1000), CONSTRAINT "pk_report_schedule" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d34ed6aedc9eb83a89cf682629" ON "report_schedule" ("is_active", "next_run_at") `);
        await queryRunner.query(`CREATE TABLE "report_run" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "report_key" character varying(60) NOT NULL, "filters" jsonb NOT NULL DEFAULT '{}'::jsonb, "format" "public"."report_format" NOT NULL, "store_scope" jsonb, "schedule_id" uuid, "user_id" uuid, "row_count" integer, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_report_run" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_812978ade0e1d251bb0992c0a3" ON "report_run" ("report_key", "created_at") `);
        await queryRunner.query(`CREATE TYPE "public"."ved_class" AS ENUM('V', 'E', 'D')`);
        await queryRunner.query(`ALTER TABLE "generic" ADD "ved_class" "public"."ved_class"`);
        await queryRunner.query(`UPDATE system_setting SET value = value || '{"reports.scheduled": "*/15 * * * *"}'::jsonb WHERE key = 'jobs.schedules'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE system_setting SET value = value - 'reports.scheduled' WHERE key = 'jobs.schedules'`);
        await queryRunner.query(`ALTER TABLE "generic" DROP COLUMN "ved_class"`);
        await queryRunner.query(`DROP TYPE "public"."ved_class"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_812978ade0e1d251bb0992c0a3"`);
        await queryRunner.query(`DROP TABLE "report_run"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d34ed6aedc9eb83a89cf682629"`);
        await queryRunner.query(`DROP TABLE "report_schedule"`);
        await queryRunner.query(`DROP TYPE "public"."report_frequency"`);
        await queryRunner.query(`DROP TYPE "public"."report_format"`);
        await queryRunner.query(`DROP TYPE "public"."report_period"`);
    }

}
