import { MigrationInterface, QueryRunner } from "typeorm";

export class Hl71761800000000 implements MigrationInterface {
    name = 'Hl71761800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."hmis_adapter_kind" ADD VALUE IF NOT EXISTS 'HL7'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // The HL7 adapter kind value stays (Postgres cannot drop an enum value).
    }

}
