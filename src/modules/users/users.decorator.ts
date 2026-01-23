import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.guard';

export const CurrentUserId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.user?.id;
});

