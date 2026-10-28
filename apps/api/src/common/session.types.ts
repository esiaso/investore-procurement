import 'express-session';

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
    /** Epoch ms when the user logged in; used for the absolute timeout. */
    loginAt?: number;
    /** Password verified, waiting for the TOTP code. */
    pending2fa?: { userId: string; at: number; attempts?: number };
    /** Secret generated during 2FA enrolment, not yet confirmed. */
    totpSetupSecret?: string;
  }
}
