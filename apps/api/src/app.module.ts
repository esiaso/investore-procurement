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
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { BudgetsModule } from './modules/budgets/budgets.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { MailModule } from './modules/mail/mail.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { NumberingModule } from './modules/numbering/numbering.module';
import { OrgModule } from './modules/org/org.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StoresModule } from './modules/stores/stores.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { PlanningModule } from './modules/planning/planning.module';
import { TaxModule } from './modules/tax/tax.module';
import { BillingModule } from './modules/billing/billing.module';
import { EtimsModule } from './modules/etims/etims.module';
import { PharmacyModule } from './modules/pharmacy/pharmacy.module';
import { ForecastingModule } from './modules/forecasting/forecasting.module';
import { ProcurementModule } from './modules/procurement/procurement.module';
import { AssetsModule } from './modules/assets/assets.module';
import { FilesModule } from './modules/files/files.module';
import { HmisModule } from './modules/hmis/hmis.module';
import { HmisIntegrationModule } from './modules/hmis/hmis-integration.module';
import { PosModule } from './modules/pos/pos.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { LabelsModule } from './modules/labels/labels.module';
import { LogisticsModule } from './modules/logistics/logistics.module';
import { QualityModule } from './modules/quality/quality.module';
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
    InventoryModule,
    ApprovalsModule,
    MailModule,
    SuppliersModule,
    BudgetsModule,
    PurchasingModule,
    StoresModule,
    JobsModule,
    PlanningModule,
    EtimsModule,
    BillingModule,
    PharmacyModule,
    ForecastingModule,
    ProcurementModule,
    FilesModule,
    QualityModule,
    LogisticsModule,
    AssetsModule,
    LabelsModule,
    HmisModule,
    HmisIntegrationModule,
    PosModule,
    AccountingModule,
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
