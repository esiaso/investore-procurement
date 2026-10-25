import { Injectable, OnModuleInit } from '@nestjs/common';
import { GrnsService } from '../purchasing/grns.service';
import { ColdChainService } from './cold-chain.service';

/** Receipts: cold-chain goods that arrived out of range are held for the Quality Officer. */
@Injectable()
export class QualityHooks implements OnModuleInit {
  constructor(
    private readonly grns: GrnsService,
    private readonly cold: ColdChainService,
  ) {}

  onModuleInit() {
    this.grns.registerPostHook(async (m, grn, lines, actor) => {
      const batchIds = [...new Set(lines.filter((l) => l.batchId && l.acceptedBaseQty > 0).map((l) => l.batchId!))];
      await this.cold.checkReceipt(m, grn, batchIds, actor.id);
    });
  }
}
