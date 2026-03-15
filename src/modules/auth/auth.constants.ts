export const AUTH_COOKIE_NAME = 'moh_session';

export const OTP_CODE_LENGTH = 6;
export const OTP_TTL_MINUTES = 10;
export const OTP_RESEND_SECONDS = 30;

export const SESSION_TTL_DAYS = 30;

// Renew the session (push expiresAt out by SESSION_TTL_DAYS) when fewer than
// this many days remain. Keeps active users permanently logged in.
export const SESSION_RENEWAL_THRESHOLD_DAYS = 7;

