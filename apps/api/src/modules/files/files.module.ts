import { BadRequestException, Body, Controller, Get, Global, Module, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { Permissions, SessionUser } from '@sil/shared';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { AttachmentOwnersRegistrar } from './attachment-owners';
import { AttachmentsService } from './attachments.service';
import { StorageService } from './storage.service';

/** Hard cap for the upload buffer; the setting files.maxSizeMb is checked after. */
export const UPLOAD_HARD_LIMIT = 100 * 1024 * 1024;

export class UploadDto {
  @ApiProperty({ example: 'GRN' }) @Matches(/^[A-Z_]{2,40}$/) ownerType: string;
  @ApiProperty() @IsUUID() ownerId: string;
  @ApiPropertyOptional({ example: 'DELIVERY_NOTE' }) @IsOptional() @Matches(/^[A-Za-z0-9_]{1,40}$/) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class AttachmentQueryDto {
  @ApiProperty() @Matches(/^[A-Z_]{2,40}$/) ownerType: string;
  @ApiProperty() @IsUUID() ownerId: string;
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() versions?: boolean;
}

/** Content-Disposition with an ASCII fallback name and the full UTF-8 name (RFC 6266); no quotes or control characters. */
export function contentDisposition(fileName: string, inline = false): string {
  const clean = fileName.replace(/[\x00-\x1f\x7f"\\]/g, '').trim() || 'file';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/** Sends a stored file with a safe name. */
export function sendFile(res: Response, a: { fileName: string; mimeType: string }, body: Buffer, inline = false) {
  res.setHeader('Content-Type', a.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(a.fileName, inline));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return new StreamableFile(body);
}

@ApiTags('attachments')
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get() @RequirePermissions()
  list(@Query() q: AttachmentQueryDto, @CurrentUser() u: SessionUser) {
    return this.attachments.list(q.ownerType, q.ownerId, u, q.versions);
  }

  /** multipart/form-data: file + ownerType, ownerId, category, notes. A file with the same name and category becomes a new version. */
  @Post() @RequirePermissions(Permissions.FILES_UPLOAD)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_HARD_LIMIT } }))
  async upload(@Body() dto: UploadDto, @UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() u: SessionUser) {
    if (!file) throw new BadRequestException('Attach a file');
    const a = await this.attachments.upload(
      { ownerType: dto.ownerType, ownerId: dto.ownerId, category: dto.category ?? 'GENERAL', fileName: file.originalname, mimeType: file.mimetype, body: file.buffer, notes: dto.notes },
      u,
    );
    const { storageKey: _k, ...rest } = a;
    return rest;
  }

  @Get(':id/download') @RequirePermissions()
  async download(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: SessionUser, @Res({ passthrough: true }) res: Response) {
    const { attachment, body } = await this.attachments.download(id, u);
    return sendFile(res, attachment, body);
  }
}

@Global()
@Module({
  controllers: [AttachmentsController],
  providers: [StorageService, AttachmentsService, AttachmentOwnersRegistrar],
  exports: [StorageService, AttachmentsService],
})
export class FilesModule {}
