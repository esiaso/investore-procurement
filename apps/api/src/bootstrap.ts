import './common/session.types';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import RedisStore from 'connect-redis';
import type { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import passport from 'passport';
import { createClient, RedisClientType } from 'redis';
import { CSRF_HEADER, csrfMiddleware } from './common/csrf';
import { requestContextMiddleware } from './common/request-context';
import { Env } from './config/env';
import { SESSION_COOKIE } from './modules/auth/auth.controller';
import { ApiClientsService, apiKeyMiddleware } from './modules/billing/api-clients.service';

export const API_PREFIX = 'api/v1';

export async function createRedisClient(env: Env): Promise<RedisClientType> {
  const client = createClient({ url: env.redisUrl }) as RedisClientType;
  client.on('error', (err) => console.error('Redis error', err));
  await client.connect();
  return client;
}

/** HTTP pipeline shared by main.ts and the integration tests. */
export function configureApp(app: NestExpressApplication, env: Env, redis: RedisClientType): void {
  app.setGlobalPrefix(API_PREFIX);
  // JSON, and FHIR from the HMIS (application/fhir+json). Replaces Nest's default JSON parser.
  app.useBodyParser('json', { type: ['application/json', 'application/fhir+json'], limit: '1mb' });
  // HL7 v2 (ER7) messages from the HMIS.
  app.useBodyParser('text', { type: ['text/plain', 'application/hl7-v2', 'x-application/hl7-v2+er7'], limit: '1mb' });
  app.set('trust proxy', env.trustProxy ? 1 : false);
  // JSON API; CSP is left to the web front end (and would block the Swagger UI).
  app.use(helmet({ contentSecurityPolicy: false }));
  app.enableCors({ origin: env.corsOrigins, credentials: true, allowedHeaders: ['Content-Type', CSRF_HEADER] });

  app.use(
    session({
      name: SESSION_COOKIE,
      store: new RedisStore({ client: redis, prefix: 'silp:sess:' }),
      secret: env.sessionSecret,
      resave: false,
      saveUninitialized: false,
      // Idle timeout: every request pushes expiry forward.
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.cookieSecure,
        maxAge: env.sessionIdleTimeoutMinutes * 60_000,
      },
    }),
  );

  // Absolute timeout: a session cannot outlive N hours after login.
  const absoluteMs = env.sessionAbsoluteTimeoutHours * 3_600_000;
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.session?.loginAt && Date.now() - req.session.loginAt > absoluteMs) {
      return req.session.regenerate((err) => next(err));
    }
    next();
  });

  app.use(passport.initialize());
  app.use(passport.session());
  app.use(apiKeyMiddleware(app.get(ApiClientsService, { strict: false }), `/${API_PREFIX}/integration/`));
  app.use(csrfMiddleware);
  app.use(requestContextMiddleware);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('SIL Procurement & Inventory API')
    .setDescription(
      'Session-cookie authentication. Call GET /auth/csrf first and send the token in the ' +
        `"${CSRF_HEADER}" header on every non-GET request.`,
    )
    .setVersion('1.0')
    .addCookieAuth(SESSION_COOKIE)
    .addApiKey({ type: 'apiKey', in: 'header', name: CSRF_HEADER }, 'csrf')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, document, { jsonDocumentUrl: `${API_PREFIX}/openapi.json` });
}
