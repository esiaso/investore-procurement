import { MigrationInterface, QueryRunner } from "typeorm";

/** Organisation → Hospital details: the letterhead logo (a PNG / JPEG data: URL) on the main facility. */
export class HospitalDetails1762900000000 implements MigrationInterface {
    name = "HospitalDetails1762900000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "facility" ADD "logo" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "facility" DROP COLUMN "logo"`);
    }
}
