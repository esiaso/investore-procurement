import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { MockHmis, MockHmisFailure, MockPrescription, seedMockHmis } from './mock-hmis';

/**
 * HTTP front for MockHmis. FHIR under /fhir (or the root), plus control endpoints:
 *   GET    /_mock/state                   counts, recent requests, last dispense and charge
 *   POST   /_mock/failure {mode, count}   inject failures (offline | timeout | http500 | http400)
 *   DELETE /_mock/failure                 clear
 *   POST   /_mock/prescriptions {MockPrescription}   a prescriber writes orders
 *   POST   /_mock/orders/:id/status {status}         stop / cancel an order
 *   POST   /_mock/reset                   empty and re-seed the sample patients
 */
export function createMockHmisServer(mock = new MockHmis()): { server: Server; mock: MockHmis } {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/fhir+json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let s = '';
      req.on('data', (d) => (s += d));
      req.on('end', () => {
        try {
          resolve(s ? JSON.parse(s) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const body = await readBody(req);
    const p = url.pathname;
    if (p.startsWith('/_mock')) {
      if (p === '/_mock/state') {
        return json(res, 200, {
          failure: mock.failure,
          counts: Object.fromEntries([...mock.store.entries()].map(([t, m]) => [t, m.size])),
          requests: mock.requests.slice(-50),
          lastDispense: mock.all('MedicationDispense').at(-1) ?? null,
          lastCharge: mock.all('ChargeItem').at(-1) ?? null,
        });
      }
      if (p === '/_mock/failure' && req.method === 'POST') {
        mock.failure = body as MockHmisFailure;
        return json(res, 200, { failure: mock.failure });
      }
      if (p === '/_mock/failure' && req.method === 'DELETE') {
        mock.failure = null;
        return json(res, 200, { failure: null });
      }
      if (p === '/_mock/prescriptions' && req.method === 'POST') return json(res, 201, { orders: mock.prescribe(body as MockPrescription) });
      const status = /^\/_mock\/orders\/([^/]+)\/status$/.exec(p);
      if (status && req.method === 'POST') return json(res, 200, mock.setOrderStatus(status[1], String((body as { status?: string })?.status ?? 'stopped')));
      if (p === '/_mock/reset' && req.method === 'POST') {
        mock.reset();
        seedMockHmis(mock);
        return json(res, 200, { reset: true });
      }
      return json(res, 404, { message: 'unknown mock control endpoint' });
    }
    const reply = mock.handle(req.method ?? 'GET', `${p}${url.search}`, body);
    if (reply.network === 'offline') return req.socket.destroy();
    if (reply.network === 'timeout') return; // never answer
    json(res, reply.status, reply.body ?? {});
  });
  return { server, mock };
}
