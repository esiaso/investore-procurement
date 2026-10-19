import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions, StoreScoped } from '../../common/decorators';
import { AdjustmentsService } from './adjustments.service';
import {
  BatchQueryDto,
  CreateAdjustmentDto,
  CreateReceiptDto,
  CreateStockTakeDto,
  CreateTransferDto,
  DispatchTransferDto,
  DocQueryDto,
  FefoQueryDto,
  LedgerQueryDto,
  PeriodLockDto,
  ReceiveTransferDto,
  ReconcileQueryDto,
  RecordCountsDto,
  RejectDto,
  SetHoldDto,
  StockQueryDto,
  TransferQueryDto,
  ValuationQueryDto,
} from './inventory.dto';
import { InventoryService } from './inventory.service';
import { ReceiptsService } from './receipts.service';
import { StockTakesService } from './stocktakes.service';
import { TransfersService } from './transfers.service';

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /** Stock on hand by batch (default) or item, with expiry and (if permitted) value. */
  @Get('stock') @RequirePermissions(Permissions.INVENTORY_READ) @StoreScoped('query.storeId')
  stock(@Query() query: StockQueryDto, @CurrentUser() user: SessionUser) {
    return this.inventory.stockOnHand(query, user);
  }

  /** Item ledger / bin card with running balance. */
  @Get('ledger') @RequirePermissions(Permissions.INVENTORY_READ) @StoreScoped('query.storeId')
  ledger(@Query() query: LedgerQueryDto) {
    return this.inventory.itemLedger(query);
  }

  @Get('valuation') @RequirePermissions(Permissions.INVENTORY_VALUATION) @StoreScoped('query.storeId')
  valuation(@Query() query: ValuationQueryDto) {
    return this.inventory.valuation(query);
  }

  /** Suggested FEFO picks for a quantity, with any shortfall. */
  @Get('fefo') @RequirePermissions(Permissions.INVENTORY_READ) @StoreScoped('query.storeId')
  fefo(@Query() query: FefoQueryDto) {
    return this.inventory.fefo(query);
  }

  @Get('batches') @RequirePermissions(Permissions.INVENTORY_READ)
  batches(@Query() query: BatchQueryDto) {
    return this.inventory.listBatches(query);
  }

  /** Every movement of a batch (who, what, when, from, to, document) and where it is now. */
  @Get('batches/:id/trace') @RequirePermissions(Permissions.INVENTORY_READ)
  trace(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.batchTrace(id);
  }

  @Put('batches/:id/hold') @RequirePermissions(Permissions.INVENTORY_BATCH_HOLD)
  hold(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetHoldDto) {
    return this.inventory.setHold(id, dto);
  }

  @Get('period-locks') @RequirePermissions(Permissions.INVENTORY_READ)
  periodLocks() {
    return this.inventory.listPeriodLocks();
  }

  @Put('period-locks') @RequirePermissions(Permissions.INVENTORY_PERIOD_LOCK) @StoreScoped('body.storeId')
  setPeriodLock(@Body() dto: PeriodLockDto) {
    return this.inventory.setPeriodLock(dto);
  }

  /** Recomputes balances from the ledger and reports any drift. */
  @Get('reconciliation') @RequirePermissions(Permissions.INVENTORY_RECONCILE) @StoreScoped('query.storeId')
  reconcile(@Query() query: ReconcileQueryDto) {
    return this.inventory.reconcile(query.storeId, false);
  }

  /** Rewrites drifted balances from the ledger (audited). */
  @Post('reconciliation/repair') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_RECONCILE) @StoreScoped('query.storeId')
  repair(@Query() query: ReconcileQueryDto) {
    return this.inventory.reconcile(query.storeId, true);
  }
}

@ApiTags('inventory')
@Controller('inventory/receipts')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get() @RequirePermissions(Permissions.INVENTORY_READ) @StoreScoped('query.storeId')
  list(@Query() query: DocQueryDto) {
    return this.receipts.list(query);
  }

  @Get(':id') @RequirePermissions(Permissions.INVENTORY_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.receipts.get(id);
  }

  /** Opening balance or temporary stock-in receipt; posts immediately. */
  @Post() @RequirePermissions(Permissions.INVENTORY_RECEIVE) @StoreScoped('body.storeId')
  create(@Body() dto: CreateReceiptDto, @CurrentUser() user: SessionUser) {
    return this.receipts.create(dto, user);
  }
}

@ApiTags('inventory')
@Controller('inventory/adjustments')
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  @Get('reasons') @RequirePermissions(Permissions.INVENTORY_READ)
  reasons() {
    return this.adjustments.listReasons();
  }

  @Get() @RequirePermissions(Permissions.INVENTORY_READ) @StoreScoped('query.storeId')
  list(@Query() query: DocQueryDto) {
    return this.adjustments.list(query);
  }

  @Get(':id') @RequirePermissions(Permissions.INVENTORY_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.adjustments.get(id);
  }

  @Post() @RequirePermissions(Permissions.INVENTORY_ADJUST) @StoreScoped('body.storeId')
  create(@Body() dto: CreateAdjustmentDto, @CurrentUser() user: SessionUser) {
    return this.adjustments.create(dto, user);
  }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_ADJUST)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.adjustments.submit(id, user);
  }

  @Post(':id/approve') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_ADJUST_APPROVE)
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.adjustments.approve(id, user);
  }

  @Post(':id/reject') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_ADJUST_APPROVE)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto, @CurrentUser() user: SessionUser) {
    return this.adjustments.reject(id, dto.reason, user);
  }
}

@ApiTags('inventory')
@Controller('inventory/transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get() @RequirePermissions(Permissions.INVENTORY_READ) @StoreScoped('query.storeId')
  list(@Query() query: TransferQueryDto) {
    return this.transfers.list(query);
  }

  @Get(':id') @RequirePermissions(Permissions.INVENTORY_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.get(id);
  }

  @Post() @RequirePermissions(Permissions.INVENTORY_TRANSFER_REQUEST) @StoreScoped('body.toStoreId')
  request(@Body() dto: CreateTransferDto, @CurrentUser() user: SessionUser) {
    return this.transfers.request(dto, user);
  }

  @Post(':id/dispatch') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_TRANSFER_DISPATCH)
  dispatch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DispatchTransferDto, @CurrentUser() user: SessionUser) {
    return this.transfers.dispatch(id, dto, user);
  }

  @Post(':id/receive') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_TRANSFER_RECEIVE)
  receive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceiveTransferDto, @CurrentUser() user: SessionUser) {
    return this.transfers.receive(id, dto, user);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_TRANSFER_REQUEST)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.cancel(id);
  }
}

@ApiTags('inventory')
@Controller('inventory/stock-takes')
export class StockTakesController {
  constructor(private readonly stockTakes: StockTakesService) {}

  @Get() @RequirePermissions(Permissions.INVENTORY_READ) @StoreScoped('query.storeId')
  list(@Query() query: DocQueryDto) {
    return this.stockTakes.list(query);
  }

  @Get(':id') @RequirePermissions(Permissions.INVENTORY_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.stockTakes.get(id);
  }

  @Post() @RequirePermissions(Permissions.INVENTORY_STOCKTAKE) @StoreScoped('body.storeId')
  create(@Body() dto: CreateStockTakeDto) {
    return this.stockTakes.create(dto);
  }

  @Post(':id/freeze') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_STOCKTAKE)
  freeze(@Param('id', ParseUUIDPipe) id: string) {
    return this.stockTakes.freeze(id);
  }

  @Post(':id/counts') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_STOCKTAKE)
  counts(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordCountsDto, @CurrentUser() user: SessionUser) {
    return this.stockTakes.recordCounts(id, dto, user);
  }

  @Post(':id/submit') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_STOCKTAKE)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.stockTakes.submit(id, user);
  }

  @Post(':id/approve') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_STOCKTAKE_APPROVE)
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.stockTakes.approve(id, user);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions(Permissions.INVENTORY_STOCKTAKE)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.stockTakes.cancel(id);
  }
}
