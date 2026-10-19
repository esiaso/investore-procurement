import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Paginated } from '@sil/shared';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export class PageQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 25, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize = 25;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

/** Note: with joins, orderBy must use property paths (`item.unitPrice`), not column names. */
export async function paginate<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  query: PageQueryDto,
): Promise<Paginated<T>> {
  const [items, total] = await qb
    .skip((query.page - 1) * query.pageSize)
    .take(query.pageSize)
    .getManyAndCount();
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/** Escapes LIKE wildcards in user search input. */
export function likeTerm(search: string): string {
  return `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
