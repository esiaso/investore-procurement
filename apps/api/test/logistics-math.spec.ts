import { BatchHoldStatus, ComplaintCategory, DisposalMethod, HoldReason, ShipmentStatus } from '@sil/shared';
import { addMonthsIso, dueForAlert } from '../src/modules/assets/assets.service';
import { safeFileName } from '../src/modules/files/attachments.service';
import { gs1BatchString, gs1CheckDigit, gtin14 } from '../src/modules/labels/labels.module';
import { orderStops } from '../src/modules/logistics/distribution.service';
import { shipmentStatus } from '../src/modules/logistics/shipments.service';
import { excursionStart, parseLoggerCsv } from '../src/modules/quality/cold-chain.service';
import { ppbReportTypeFor } from '../src/modules/quality/complaints.service';
import { disposalProblems } from '../src/modules/quality/disposals.service';
import { batchStatusFor } from '../src/modules/quality/holds.service';

const at = (min: number) => new Date(Date.UTC(2026, 9, 25, 8, 0) + min * 60_000);

describe('cold chain', () => {
  const range = { min: 2, max: 8 };

  it('an excursion is a run of out-of-range readings lasting the configured minutes', () => {
    expect(excursionStart([{ at: at(0), t: 5 }, { at: at(10), t: 9 }], range, 0)).toEqual(at(10));
    expect(excursionStart([{ at: at(0), t: 9 }, { at: at(10), t: 10 }], range, 30)).toBeNull(); // 10 min only
    expect(excursionStart([{ at: at(0), t: 9 }, { at: at(40), t: 10 }], range, 30)).toEqual(at(0));
    expect(excursionStart([{ at: at(0), t: 9 }, { at: at(20), t: 5 }, { at: at(30), t: 1.5 }], range, 0)).toEqual(at(30)); // a reading back in range resets the run
    expect(excursionStart([{ at: at(0), t: 2 }, { at: at(5), t: 8 }], range, 0)).toBeNull(); // limits are inclusive
  });

  it('reads logger CSV exports with loosely named columns (local time = Nairobi)', () => {
    const rows = parseLoggerCsv('\uFEFFDate/Time,Temp °C,Logger\n2026-10-25 08:00,4.5,FR-1\n2026-10-25T09:00:00Z,"5,5",FR-1\n');
    expect(rows).toEqual([
      { at: new Date('2026-10-25T05:00:00Z'), t: 4.5, unit: 'FR-1' },
      { at: new Date('2026-10-25T09:00:00Z'), t: 5.5, unit: 'FR-1' },
    ]);
    expect(() => parseLoggerCsv('a,b\n1,2\n')).toThrow(/timestamp column/);
    expect(() => parseLoggerCsv('time,temp\nyesterday,4\n')).toThrow(/Row 2/);
  });
});

describe('holds and disposal', () => {
  it('a batch is RECALL while a recall hold is open, QUARANTINE for other holds, then usable (or expired)', () => {
    expect(batchStatusFor([HoldReason.EXCURSION, HoldReason.RECALL], null, '2026-10-25')).toBe(BatchHoldStatus.RECALL);
    expect(batchStatusFor([HoldReason.INSPECTION], null, '2026-10-25')).toBe(BatchHoldStatus.QUARANTINE);
    expect(batchStatusFor([], '2027-01-01', '2026-10-25')).toBe(BatchHoldStatus.NONE);
    expect(batchStatusFor([], '2026-10-25', '2026-10-25')).toBe(BatchHoldStatus.EXPIRED);
  });

  it('a disposal needs its committee, a recipient for sales / donations, and a public notice for a sale under PPADA', () => {
    const d = { method: DisposalMethod.DESTRUCTION, recipient: null, publicNoticeRef: null };
    expect(disposalProblems(d, 2, 2, false)).toEqual([]);
    expect(disposalProblems(d, 1, 2, false)).toEqual(['2 committee sign-offs are needed (1 so far)']);
    expect(disposalProblems({ ...d, method: DisposalMethod.SALE }, 2, 2, false)).toEqual(['Name the buyer, receiving facility or supplier']);
    expect(disposalProblems({ ...d, method: DisposalMethod.SALE, recipient: 'Scrap dealer' }, 2, 2, false)).toEqual([]);
    expect(disposalProblems({ ...d, method: DisposalMethod.SALE, recipient: 'Scrap dealer' }, 2, 2, true)).toEqual([expect.stringMatching(/public notice/)]);
  });

  it('complaints map to the PPB report type', () => {
    expect(ppbReportTypeFor(ComplaintCategory.ADVERSE_REACTION)).toBe('ADR');
    expect(ppbReportTypeFor(ComplaintCategory.SUSPECTED_FALSIFIED)).toBe('PQM');
  });
});

describe('logistics', () => {
  it('stops follow the route order, unknown stores last by name', () => {
    const s = (toStoreId: string, storeName: string) => ({ toStoreId, storeName });
    expect(orderStops([s('a', 'Zeta'), s('b', 'Beta'), s('c', 'Alpha')], ['b', 'a']).map((x) => x.toStoreId)).toEqual(['b', 'a', 'c']);
  });

  it('shipment status from receipts and dates', () => {
    const line = (quantity: number, receivedQty: number) => ({ quantity, receivedQty });
    expect(shipmentStatus([line(10, 10)], '2026-10-01', '2026-10-25', 0, true)).toBe(ShipmentStatus.RECEIVED);
    expect(shipmentStatus([line(10, 4)], '2026-10-01', '2026-10-25', 0, true)).toBe(ShipmentStatus.PARTIALLY_RECEIVED);
    expect(shipmentStatus([line(10, 0)], '2026-10-24', '2026-10-25', 0, true)).toBe(ShipmentStatus.DELAYED);
    expect(shipmentStatus([line(10, 0)], '2026-10-24', '2026-10-25', 2, true)).toBe(ShipmentStatus.IN_TRANSIT); // grace
    expect(shipmentStatus([line(10, 0)], '2026-11-24', '2026-10-25', 0, false)).toBe(ShipmentStatus.EXPECTED);
  });

  it('asset dates', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2026-10-25', 6)).toBe('2027-04-25');
    expect(dueForAlert('2026-11-10', null, '2026-10-25', 30)).toBe(true);
    expect(dueForAlert('2026-11-10', '2026-11-10', '2026-10-25', 30)).toBe(false); // already alerted
    expect(dueForAlert('2027-01-10', null, '2026-10-25', 30)).toBe(false);
    expect(dueForAlert(null, null, '2026-10-25', 30)).toBe(false);
  });
});

describe('labels and files', () => {
  it('GS1: check digits, GTIN-14 and the batch element string', () => {
    expect(gs1CheckDigit('0950600013435')).toBe(2);
    expect(gtin14('9506000134352')).toBe('09506000134352');
    expect(gtin14('9506000134353')).toBeNull(); // wrong check digit
    expect(gtin14('ABC')).toBeNull();
    expect(gs1BatchString('09506000134352', '2027-03-31', 'L 123/A')).toBe('(01)09506000134352(17)270331(10)L123/A');
    expect(gs1BatchString('09506000134352', null, 'B1')).toBe('(01)09506000134352(10)B1');
  });

  it('file names are made safe', () => {
    expect(safeFileName('C:\\Users\\x\\Delivery note (1).pdf')).toBe('Delivery note (1).pdf');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('inv<script>.pdf')).toBe('inv_script_.pdf');
  });
});
