/**
 * Mock HMIS for development (compose service "mock-hmis"): an in-memory FHIR
 * R4 server seeded with the sample patients, and an HL7 v2 receiver over MLLP
 * that acknowledges dispenses (RDS) and charges (DFT). NOT a real HMIS.
 */
import { createServer } from 'node:net';
import { mllpFrames } from './modules/hmis/hl7-adapter';
import { MLLP } from './modules/hmis/hl7';
import { seedMockHmis } from './modules/hmis/mock/mock-hmis';
import { createMockHmisServer } from './modules/hmis/mock/mock-hmis-server';

const port = Number(process.env.MOCK_HMIS_PORT ?? 8090);
const mllpPort = Number(process.env.MOCK_HL7_PORT ?? 2575);
const { server, mock, hl7 } = createMockHmisServer();
seedMockHmis(mock);
server.listen(port, () => console.log(`mock HMIS listening on :${port} (FHIR R4 under /fhir; control at /_mock)`));

createServer((sock) => {
  let buffer = '';
  sock.on('data', (d) => {
    const { messages, rest } = mllpFrames(buffer + d.toString('utf8'));
    buffer = rest;
    for (const m of messages) {
      const r = hl7.handle(m);
      if (r.error) return void sock.destroy();
      sock.write(`${MLLP.start}${r.reply}${MLLP.end}`);
    }
  });
  sock.on('error', () => undefined);
}).listen(mllpPort, () => console.log(`mock HMIS HL7 v2 (MLLP) listening on :${mllpPort}`));
