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
        // If the handler already returned an envelope (e.g. { data, pagination }), leave it alone.
        if (isObject(body) && 'data' in body) return body;
        return { data: body };
      }),
    );
  }
}

