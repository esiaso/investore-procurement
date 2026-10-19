import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RbacController } from './rbac.controller';
import { Permission, Role } from './rbac.entities';
import { RbacService } from './rbac.service';

@Module({
  imports: [TypeOrmModule.forFeature([Role, Permission])],
  controllers: [RbacController],
  providers: [RbacService],
  exports: [RbacService],
})
export class RbacModule {}
