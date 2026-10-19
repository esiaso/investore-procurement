import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuditAction, LoginResponse, SessionUser } from '@sil/shared';
import { ensureCsrfToken } from '../../common/csrf';
import { AllowPendingPasswordChange, CurrentUser, Public } from '../../common/decorators';
import { RequestContext } from '../../common/request-context';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { ChangePasswordDto, DisableTotpDto, LoginDto, TotpCodeDto } from './auth.dto';
import { AuthService } from './auth.service';
import { LocalAuthGuard } from './passport';

export const SESSION_COOKIE = 'silp.sid';

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function logIn(req: Request, user: SessionUser): Promise<void> {
  return new Promise((resolve, reject) => req.logIn(user, (err) => (err ? reject(err) : resolve())));
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Issues (or returns) the CSRF token bound to the session. Call before login. */
  @Public()
  @Get('csrf')
  csrf(@Req() req: Request) {
    return { csrfToken: ensureCsrfToken(req) };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @UseGuards(LocalAuthGuard)
  @ApiBody({ type: LoginDto })
  async login(@Req() req: Request): Promise<LoginResponse> {
    const user = req.user as User;
    req.user = undefined;
    if (user.totpEnabled) {
      // New session id, but not logged in until the code is verified.
      await regenerate(req);
      req.session.pending2fa = { userId: user.id, at: Date.now() };
      return { twoFactorRequired: true, user: null, csrfToken: ensureCsrfToken(req) };
    }
    return this.completeLogin(req, user.id);
  }

  @Public()
  @Post('2fa/verify')
  @HttpCode(200)
  async verifySecondFactor(@Req() req: Request, @Body() dto: TotpCodeDto): Promise<LoginResponse> {
    const pending = req.session.pending2fa;
    const ttl = await this.settings.get('security.pending2faTtlSeconds');
    if (!pending || Date.now() - pending.at > ttl * 1000) {
      delete req.session.pending2fa;
      throw new UnauthorizedException('Login expired; sign in again');
    }
    if (!(await this.auth.verifySecondFactor(pending.userId, dto.code))) {
      throw new UnauthorizedException('Invalid code');
    }
    return this.completeLogin(req, pending.userId);
  }

  private async completeLogin(req: Request, userId: string): Promise<LoginResponse> {
    const sessionUser = await this.users.findForSession(userId);
    if (!sessionUser) throw new UnauthorizedException('Invalid username or password');
    await logIn(req, sessionUser); // regenerates the session id (fixation protection)
    req.session.loginAt = Date.now();
    RequestContext.setUser(sessionUser);
    await this.auth.onLoggedIn(sessionUser.id, sessionUser.username);
    return { twoFactorRequired: false, user: sessionUser, csrfToken: ensureCsrfToken(req) };
  }

  @Post('logout')
  @HttpCode(204)
  @AllowPendingPasswordChange()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.audit.record({ action: AuditAction.LOGOUT, entityType: 'User', entityId: (req.user as SessionUser).id });
    await new Promise<void>((resolve, reject) => req.logout((err) => (err ? reject(err) : resolve())));
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie(SESSION_COOKIE);
  }

  @Get('me')
  @AllowPendingPasswordChange()
  me(@CurrentUser() user: SessionUser): SessionUser {
    return user;
  }

  @Post('change-password')
  @HttpCode(204)
  @AllowPendingPasswordChange()
  changePassword(@CurrentUser() user: SessionUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  /** Starts TOTP enrolment: returns the secret and a QR code to scan. */
  @Post('2fa/setup')
  @HttpCode(200)
  async setupTotp(@Req() req: Request, @CurrentUser() user: SessionUser) {
    if (user.totpEnabled) throw new BadRequestException('Two-factor authentication is already enabled');
    const enrolment = await this.auth.startTotpEnrolment(user.username);
    req.session.totpSetupSecret = enrolment.secret;
    return enrolment;
  }

  @Post('2fa/enable')
  @HttpCode(204)
  async enableTotp(@Req() req: Request, @CurrentUser() user: SessionUser, @Body() dto: TotpCodeDto) {
    const secret = req.session.totpSetupSecret;
    if (!secret) throw new BadRequestException('Start two-factor setup first');
    await this.auth.enableTotp(user.id, secret, dto.code);
    delete req.session.totpSetupSecret;
  }

  @Post('2fa/disable')
  @HttpCode(204)
  disableTotp(@CurrentUser() user: SessionUser, @Body() dto: DisableTotpDto) {
    return this.auth.disableTotp(user.id, dto.password, dto.code);
  }
}
