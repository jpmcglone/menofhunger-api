import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

type ApiError = {
  code: number;
  message: string;
  reason?: string;
};

type ErrorEnvelope = {
  meta: {
    status: number;
    errors: ApiError[];
    requestId?: string;
  };
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractHttpMessage(exception: HttpException): { message: string; reason?: string } {
  const res = exception.getResponse();
  if (typeof res === 'string') return { message: res };
  if (isObject(res)) {
    const message = res.message;
    const error = res.error;
    if (Array.isArray(message)) {
      return { message: message.join('\n'), reason: typeof error === 'string' ? error : undefined };
    }
    if (typeof message === 'string') {
      return { message, reason: typeof error === 'string' ? error : undefined };
    }
  }
  return { message: exception.message };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = ctx.getRequest<any>();
    const requestId = (req?.requestId as string | undefined) ?? (req?.headers?.['x-request-id'] as string | undefined) ?? null;

    // Zod validation errors
    if (exception instanceof ZodError) {
      const errors: ApiError[] = exception.issues.map((i) => ({
        code: HttpStatus.BAD_REQUEST,
        message: i.message,
        reason: i.path.length ? i.path.join('.') : 'validation',
      }));
      const payload: ErrorEnvelope = {
        meta: {
          status: HttpStatus.BAD_REQUEST,
          errors: errors.length ? errors : [{ code: 400, message: 'Invalid request', reason: 'validation' }],
        },
      };
      return res.status(HttpStatus.BAD_REQUEST).json(payload);
    }

    // Nest HTTP exceptions
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const { message, reason } = extractHttpMessage(exception);
      const payload: ErrorEnvelope = {
        meta: {
          status,
          errors: [
            {
              code: status,
              message,
              reason,
            },
          ],
        },
      };
      const withReqId = requestId ? ({ ...payload, meta: { ...payload.meta, requestId } } as any) : payload;
      return res.status(status).json(withReqId);
    }

    // Unknown
    // IMPORTANT: We still return a safe error envelope, but log the underlying error for debugging.
    // eslint-disable-next-line no-console
    console.error('[API] Unhandled exception', { requestId }, exception);
    const payload: ErrorEnvelope = {
      meta: {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        errors: [
          {
            code: HttpStatus.INTERNAL_SERVER_ERROR,
            message: 'Internal server error',
            reason: 'internal_error',
          },
        ],
      },
    };
    const withReqId = requestId ? ({ ...payload, meta: { ...payload.meta, requestId } } as any) : payload;
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(withReqId);
  }
}

