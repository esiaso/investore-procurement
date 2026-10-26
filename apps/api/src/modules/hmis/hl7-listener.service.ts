import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { createServer, Server, Socket } from 'node:net';
import { RequestContext } from '../../common/request-context';
import { MLLP } from './hl7';
import { mllpFrames } from './hl7-adapter';
import { HmisInboundService } from './hmis-inbound.service';

/**
 * MLLP listener for an HL7 v2 HMIS (ADT, RDE^O11, OMP^O09). Listens only when
 * HL7_MLLP_PORT is set (the API process; not the worker). Each framed message
 * is processed in order and answered with its ACK on the same connection.
 */
@Injectable()
export class Hl7ListenerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('HL7-MLLP');
  private server: Server | null = null;

  constructor(private readonly inbound: HmisInboundService) {}

  onApplicationBootstrap() {
    const port = Number(process.env.HL7_MLLP_PORT ?? 0);
    if (!port) return;
    this.server = createServer((sock) => this.serve(sock));
    this.server.on('error', (e) => this.log.error(`MLLP listener: ${e.message}`));
    this.server.listen(port, () => this.log.log(`HL7 v2 MLLP listening on :${port}`));
  }

  private serve(sock: Socket) {
    let buffer = '';
    let chain = Promise.resolve();
    sock.on('data', (d) => {
      const { messages, rest } = mllpFrames(buffer + d.toString('utf8'));
      buffer = rest;
      for (const msg of messages) {
        chain = chain.then(async () => {
          const { ack } = await RequestContext.run({ username: 'system:hl7', userId: null, storeIds: null }, () => this.inbound.receiveHl7(msg, 'MLLP')).catch((e: Error) => {
            this.log.error(`HL7 message failed: ${e.message}`);
            return { ack: `MSH|^~\\&|SIL-PIS|SIL|HMIS|HMIS|||ACK|ERR|P|2.5.1\rMSA|AE||Internal error` };
          });
          if (!sock.destroyed) sock.write(`${MLLP.start}${ack}${MLLP.end}`);
        });
      }
    });
    sock.on('error', () => undefined);
  }

  async onModuleDestroy() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
