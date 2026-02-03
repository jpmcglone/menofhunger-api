#!/usr/bin/env node
/**
 * Production env check: exits 1 if required vars are missing.
 * Run before deploy or in CI (ensure env is loaded, e.g. from .env or Render env).
 * Example: node scripts/check-env.mjs
 */
const isProd = process.env.NODE_ENV === 'production'
const missing = []

if (!process.env.DATABASE_URL?.trim()) missing.push('DATABASE_URL')
if (isProd) {
  const session = process.env.SESSION_HMAC_SECRET?.trim()
  const otp = process.env.OTP_HMAC_SECRET?.trim()
  const devSession = 'dev-session-secret-change-me'
  const devOtp = 'dev-otp-secret-change-me'
  if (!session || session === devSession) missing.push('SESSION_HMAC_SECRET (set and not dev default)')
  if (!otp || otp === devOtp) missing.push('OTP_HMAC_SECRET (set and not dev default)')
}

if (missing.length > 0) {
  console.error('Missing or invalid required env:', missing.join('; '))
  process.exit(1)
}
console.log('Required env OK')
