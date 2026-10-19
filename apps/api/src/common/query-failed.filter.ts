import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { QueryFailedError } from 'typeorm';

/** Maps database constraint violations to 409 responses instead of 500s. */
@Catch(QueryFailedError)
export class QueryFailedFilter implements ExceptionFilter {
  catch(exception: QueryFailedError & { code?: string; detail?: string; constraint?: string }, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    switch (exception.code) {
      case '23505':
        return res.status(HttpStatus.CONFLICT).json({
          statusCode: 409,
          message: 'A record with the same unique value already exists',
          detail: exception.detail,
          constraint: exception.constraint,
        });
      case '23503':
        return res.status(HttpStatus.CONFLICT).json({
          statusCode: 409,
          message: 'Record is referenced by other records (deactivate it instead) or references a missing record',
          detail: exception.detail,
          constraint: exception.constraint,
        });
      case '22P02':
        return res.status(HttpStatus.BAD_REQUEST).json({ statusCode: 400, message: 'Invalid identifier or value' });
      default:
        // eslint-disable-next-line no-console
        console.error(exception);
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Database error' });
    }
  }
}
