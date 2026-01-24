export interface OtpProvider {
  start(to: string): Promise<void>;
  check(to: string, code: string): Promise<boolean>;
}

