import { Injectable } from '@nestjs/common';
import type { OtpProvider } from './otp-provider';

@Injectable()
export class NoopOtpProvider implements OtpProvider {
  async start(): Promise<void> {
    // no-op
  }

  async check(): Promise<boolean> {
    return false;
  }
}

