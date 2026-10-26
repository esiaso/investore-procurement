/**
 * Mock HMIS for development (compose service "mock-hmis"): an in-memory FHIR
 * R4 server seeded with the sample patients. NOT a real HMIS.
 */
import { seedMockHmis } from './modules/hmis/mock/mock-hmis';
import { createMockHmisServer } from './modules/hmis/mock/mock-hmis-server';

const port = Number(process.env.MOCK_HMIS_PORT ?? 8090);
const { server, mock } = createMockHmisServer();
seedMockHmis(mock);
server.listen(port, () => console.log(`mock HMIS listening on :${port} (FHIR R4 under /fhir; control at /_mock)`));
