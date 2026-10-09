import 'express';

declare module 'express-serve-static-core' {
  interface Request {
    /** Raw JSON body, captured for webhook signature verification. */
    rawBody?: Buffer;
    /** Correlation id assigned by the request-id middleware. */
    requestId?: string;
  }
}
