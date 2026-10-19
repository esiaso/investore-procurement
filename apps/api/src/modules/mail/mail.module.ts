import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailOutbox } from './mail.entities';
import { MailService } from './mail.service';
import { PdfService } from './pdf.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([EmailOutbox])],
  providers: [MailService, PdfService],
  exports: [MailService, PdfService],
})
export class MailModule {}
