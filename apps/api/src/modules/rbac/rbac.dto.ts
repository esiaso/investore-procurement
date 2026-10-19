import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9_]{2,40}$/) code: string;
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayUnique() @IsString({ each: true }) permissionCodes: string[];
}

export class UpdateRoleDto extends PartialType(OmitType(CreateRoleDto, ['code'] as const)) {}
