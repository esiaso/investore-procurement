import type { INestApplicationContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JobsService } from '../../modules/jobs/jobs.service';

/**
 * First start of a sample database: run the planning jobs once (AMC and
 * levels, expiry holds and alerts, reorder alerts) so the reports, alerts and
 * dashboard have data. Runs in-process whatever JOBS_MODE is; skipped once any
 * store item setting exists.
 */
export async function seedSamplePlanning(app: INestApplicationContext, log: (m: string) => void = (m) => console.log(`[seed] ${m}`)) {
  const ds = app.get(DataSource);
  const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM store_item_setting`);
  const [{ f }] = await ds.query(`SELECT count(*)::int AS f FROM facility WHERE code = 'SIL-NBI'`);
  if (n > 0 || f === 0) return;
  const jobs = app.get(JobsService);
  const results: string[] = [];
  for (const name of ['stock.amc', 'stock.expiry']) {
    const run = await jobs.run(name, {}, 'seed');
    results.push(`${name}: ${run.status} ${JSON.stringify(run.result ?? run.error)}`);
  }
  // Sample history is short, so AUTO levels are low: give a few Main Store and Main Pharmacy
  // items MANUAL levels just above their stock so the reorder report has suggestions.
  await ds.query(
    `WITH pick AS (
       SELECT sis.id, COALESCE(SUM(sb.on_hand - sb.reserved), 0) AS avail,
              ROW_NUMBER() OVER (PARTITION BY sis.store_id ORDER BY i.code) AS rn
         FROM store_item_setting sis JOIN store s ON s.id = sis.store_id AND s.code IN ('MS', 'MP')
         JOIN item i ON i.id = sis.item_id AND NOT i.is_controlled
         LEFT JOIN stock_balance sb ON sb.store_id = sis.store_id AND sb.item_id = sis.item_id
        GROUP BY sis.id, sis.store_id, i.code
       HAVING COALESCE(SUM(sb.on_hand - sb.reserved), 0) > 0
     )
     UPDATE store_item_setting t
        SET mode = 'MANUAL', reorder_level = CEIL(pick.avail * 1.2), max_level = CEIL(pick.avail * 3),
            reorder_qty = CEIL(pick.avail * 1.8), min_level = CEIL(pick.avail * 0.5), safety_stock = CEIL(pick.avail * 0.5)
       FROM pick WHERE pick.id = t.id AND pick.rn <= 4`,
  );
  const run = await jobs.run('stock.reorder', {}, 'seed');
  results.push(`stock.reorder: ${run.status} ${JSON.stringify(run.result ?? run.error)}`);
  log(`sample planning: ${results.join('; ')}`);
}
