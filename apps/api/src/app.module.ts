import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthenticatedGuard, PermissionsGuard, StoreScopeGuard } from './common/guards';
import { QueryFailedFilter } from './common/query-failed.filter';
import { loadEnv } from './config/env';
import { typeOrmOptions } from './database/typeorm-options';
import { HealthController } from './health.controller';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { NumberingModule } from './modules/numbering/numbering.module';
import { OrgModule } from './modules/org/org.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { SettingsModule } from './modules/settings/settings.module';
import { TaxModule } from './modules/tax/tax.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...typeOrmOptions(), migrationsRun: loadEnv().migrationsRun }),
    }),
    AuditModule,
    SettingsModule,
    TaxModule,
    NumberingModule,
    OrgModule,
    RbacModule,
    UsersModule,
    AuthModule,
    CatalogModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: authentication, then permissions, then store scope.
    { provide: APP_GUARD, useClass: AuthenticatedGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: StoreScopeGuard },
    { provide: APP_FILTER, useClass: QueryFailedFilter },
  ],
})
export class AppModule {}
