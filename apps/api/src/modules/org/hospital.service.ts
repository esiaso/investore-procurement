import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { HospitalDetailsDto } from './org.dto';
import { Facility } from './org.entities';

const MAX_LOGO_BYTES = 500 * 1024;

/**
 * The hospital as shown on documents: the main facility (the first active one)
 * supplies the letterhead name, address, contacts, KRA PIN and logo; the
 * mail.fromAddress setting is the sender of outgoing e-mail. Changes go through
 * the entity / setting repositories, so the audit log records them.
 */
@Injectable()
export class HospitalService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: SettingsService,
  ) {}

  private async main(m: EntityManager = this.ds.manager): Promise<Facility> {
    const f = await m.getRepository(Facility).findOne({ where: { isActive: true }, order: { createdAt: 'ASC' } });
    if (!f) throw new NotFoundException('No facility is set up');
    return f;
  }

  async get() {
    const f = await this.main();
    const [{ has }] = await this.ds.query(`SELECT logo IS NOT NULL AS has FROM facility WHERE id = $1`, [f.id]);
    return {
      id: f.id,
      code: f.code,
      name: f.name,
      address: f.address,
      phone: f.phone,
      email: f.email,
      kraPin: f.kraPin,
      hasLogo: has as boolean,
      mailFrom: await this.settings.get('mail.fromAddress'),
    };
  }

  async update(dto: HospitalDetailsDto) {
    await this.ds.transaction(async (m) => {
      const f = await this.main(m);
      Object.assign(f, { name: dto.name.trim(), address: dto.address ?? null, phone: dto.phone ?? null, email: dto.email ?? null, kraPin: dto.kraPin ?? null });
      await m.save(f);
    });
    if (dto.mailFrom !== (await this.settings.get('mail.fromAddress'))) await this.settings.update('mail.fromAddress', dto.mailFrom.trim());
    return this.get();
  }

  async getLogo(): Promise<{ dataUrl: string | null }> {
    const f = await this.main();
    const [row] = await this.ds.query(`SELECT logo FROM facility WHERE id = $1`, [f.id]);
    return { dataUrl: row?.logo ?? null };
  }

  /** PNG or JPEG only (checked by content, not by the declared type), at most 500 KB. */
  async setLogo(dataUrl: string | null) {
    if (dataUrl !== null) {
      const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
      if (!m) throw new BadRequestException({ code: 'LOGO_TYPE', message: 'The logo must be a PNG or JPEG image' });
      const bytes = Buffer.from(m[2], 'base64');
      const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if ((m[1] === 'png' && !png) || (m[1] === 'jpeg' && !jpeg)) throw new BadRequestException({ code: 'LOGO_TYPE', message: `The file content is not a ${m[1].toUpperCase()} image` });
      if (bytes.length > MAX_LOGO_BYTES) throw new BadRequestException({ code: 'LOGO_SIZE', message: 'The logo must be at most 500 KB' });
      dataUrl = `data:image/${m[1]};base64,${bytes.toString('base64')}`;
    }
    await this.ds.transaction(async (m) => {
      const f = await this.main(m);
      f.logo = dataUrl;
      await m.save(f);
    });
    return this.get();
  }
}
