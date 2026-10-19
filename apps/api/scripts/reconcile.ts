/**
 * Scheduled-job entry point: recomputes balances from the ledger and reports
 * drift. Exits 1 when drift is found (so cron/CI can alert).
 *
 *   pnpm --filter @sil/api inventory:reconcile [-- --store <id>] [-- --repair]
 *
 * Moves to a BullMQ repeatable job once the queue lands.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { RequestContext } from '../src/common/request-context';
import { InventoryService } from '../src/modules/inventory/inventory.service';

async function main() {
  const args = process.argv.slice(2);
  const storeIdx = args.indexOf('--store');
  const storeId = storeIdx >= 0 ? args[storeIdx + 1] : undefined;
  const repair = args.includes('--repair');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const result = await RequestContext.run({ username: 'system:reconcile' }, () =>
      app.get(InventoryService).reconcile(storeId, repair),
    );
    console.log(JSON.stringify({ checked: result.checked, driftCount: result.driftCount, repaired: result.repaired }, null, 2));
    for (const d of result.drift.slice(0, 50)) console.log(JSON.stringify(d));
    process.exitCode = result.driftCount && !repair ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
