import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export type ApiResponse<T> = { data: T } & Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((body: unknown) => {
        // Pass through null/undefined (e.g. 204 No Content handlers) so we don't produce
        // a body on no-content responses, which violates HTTP semantics.
        if (body === undefined || body === null) return body;
        // If the handler already returned an envelope (e.g. { data, pagination }), leave it alone.
        if (isObject(body) && 'data' in body) return body;
        return { data: body };
      }),
    );
  }
}

