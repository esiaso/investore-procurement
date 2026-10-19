import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../common/pagination';

const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);

export class CreateUserDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @Matches(/^[a-z0-9._-]{3,60}$/)
  username: string;

  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) fullName: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((o) => o.email !== null)
  @IsEmail()
  email?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phone?: string | null;

  /** Initial password; the user must change it at first login. */
  @ApiProperty() @IsString() @MaxLength(200) password: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;

  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsUUID('all', { each: true }) roleIds: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  storeIds?: string[];

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(emptyToNull) @IsUUID() departmentId?: string | null;
}

export class UpdateUserDto extends PartialType(OmitType(CreateUserDto, ['username', 'password'] as const)) {}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @MaxLength(200) password: string;
}

export class UserQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() roleId?: string;
}
