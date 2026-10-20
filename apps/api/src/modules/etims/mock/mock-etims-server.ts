import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { Failure, MockEtims } from './mock-etims';

/**
 * HTTP front for MockEtims. Serves the OSCU and VSCU paths under any prefix
 * (e.g. /etims-api/saveTrnsSalesOsdc) plus control endpoints:
 *   GET    /_mock/state                 counts and last documents
 *   POST   /_mock/failure  {Failure}     inject failures
 *   DELETE /_mock/failure                clear
 *   POST   /_mock/purchases {buyerTin, sale}  offer a supplier sale
 *   POST   /_mock/imports  {buyerTin, item}   offer an import declaration
 *   POST   /_mock/reset
 */
export function createMockEtimsServer(mock = new MockEtims()): { server: Server; mock: MockEtims } {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let s = '';
      req.on('data', (d) => (s += d));
      req.on('end', () => {
        try {
          resolve(s ? JSON.parse(s) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const body = await readBody(req);
    if (url.pathname.startsWith('/_mock')) {
      const p = url.pathname;
      if (p === '/_mock/state') {
        return json(res, 200, {
          failure: mock.failure,
          requests: mock.requests,
          devices: mock.devices.size,
          items: mock.items.size,
          sales: mock.sales.size,
          stockIO: mock.stockIO.length,
          stockMaster: mock.stockMaster.length,
          lastSale: [...mock.sales.values()].at(-1) ?? null,
          lastStockIO: mock.stockIO.at(-1) ?? null,
        });
      }
      if (p === '/_mock/failure' && req.method === 'POST') {
        mock.failure = body as unknown as Failure;
        return json(res, 200, { failure: mock.failure });
      }
      if (p === '/_mock/failure' && req.method === 'DELETE') {
        mock.failure = null;
        return json(res, 200, { failure: null });
      }
      if (p === '/_mock/purchases' && req.method === 'POST') {
        mock.offerPurchase(String(body.buyerTin), body.sale as Record<string, unknown>);
        return json(res, 200, { offered: mock.offeredPurchases.length });
      }
      if (p === '/_mock/imports' && req.method === 'POST') {
        mock.imports.push({ ...(body.item as Record<string, unknown>), buyerTin: String(body.buyerTin) });
        return json(res, 200, { imports: mock.imports.length });
      }
      if (p === '/_mock/reset' && req.method === 'POST') {
        mock.reset();
        return json(res, 200, { reset: true });
      }
      return json(res, 404, { message: 'unknown mock control endpoint' });
    }
    // Strip any prefix before the operation path ("/etims-api/selectCodeList" → "/selectCodeList").
    const segments = url.pathname.split('/').filter(Boolean);
    const op = mock.operationFor(`/${segments.slice(-1).join('/')}`) ?? mock.operationFor(`/${segments.slice(-2).join('/')}`);
    if (!op || req.method !== 'POST') return json(res, 404, { resultCd: '912', resultMsg: 'There is a request Method error.' });
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    const reply = mock.handle(op, headers, body);
    if (reply.network === 'offline') return req.socket.destroy();
    if (reply.network === 'timeout') return; // never answer
    json(res, reply.status, reply.body ?? {});
  });
  return { server, mock };
}
