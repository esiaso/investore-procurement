import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty() @IsString() @MaxLength(100) username: string;
  @ApiProperty() @IsString() @MaxLength(200) password: string;
}

export class TotpCodeDto {
  @ApiProperty({ example: '123456' }) @IsString() @Matches(/^\d{6}$/) code: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(200) currentPassword: string;
  @ApiProperty() @IsString() @MaxLength(200) newPassword: string;
}

export class DisableTotpDto {
  @ApiProperty() @IsString() @MaxLength(200) password: string;
  @ApiProperty() @IsString() @Matches(/^\d{6}$/) code: string;
}
