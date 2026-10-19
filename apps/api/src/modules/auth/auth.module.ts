import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LocalStrategy, SessionSerializer } from './passport';
import { TotpService } from './totp.service';

@Module({
  imports: [PassportModule, UsersModule],
  controllers: [AuthController],
  providers: [AuthService, TotpService, LocalStrategy, SessionSerializer],
  exports: [TotpService],
})
export class AuthModule {}
