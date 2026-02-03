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

