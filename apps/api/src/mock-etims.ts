/**
 * Mock KRA eTIMS control unit for development (compose service "mock-etims").
 * NOT KRA: a stand-in that speaks the OSCU/VSCU protocol with injectable failures.
 */
import { createMockEtimsServer } from './modules/etims/mock/mock-etims-server';

const port = Number(process.env.MOCK_ETIMS_PORT ?? 8088);
const { server } = createMockEtimsServer();
server.listen(port, () => console.log(`mock eTIMS listening on :${port} (OSCU paths under /etims-api, VSCU paths at the root; control at /_mock)`));
