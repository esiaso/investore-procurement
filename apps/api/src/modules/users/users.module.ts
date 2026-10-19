import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrgModule } from '../org/org.module';
import { RbacModule } from '../rbac/rbac.module';
import { PasswordService } from './password.service';
import { User } from './user.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User]), RbacModule, OrgModule],
  controllers: [UsersController],
  providers: [UsersService, PasswordService],
  exports: [UsersService, PasswordService],
})
export class UsersModule {}
