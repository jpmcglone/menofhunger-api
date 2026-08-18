import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.guard';

export const CurrentUserId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.user?.id;
});

/**
 * For routes guarded by OptionalAuthGuard: returns the current user id or undefined.
 * Use when the endpoint works for both authenticated and anonymous users.
 */
export const OptionalCurrentUserId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.user?.id;
});

/**
 * True when a site admin is driving this session via impersonation ("log in as user").
 * Use to suppress side effects that would forge activity on the impersonated account —
 * presence, read receipts, push-device binding.
 */
export const IsImpersonating = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return Boolean(req.user?.impersonatedByUserId);
});

export const CurrentAccountKind = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.user?.accountKind ?? 'person';
});

/**
 * Person who owns this device's push tokens. Page sessions bind to the operator;
 * a page with no operator returns null so we never register a token on the page.
 */
export const CurrentOperatorUserId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (req.user?.operatedByUserId) return req.user.operatedByUserId;
  if (req.user?.accountKind === 'page') return null;
  return req.user?.id ?? null;
});

