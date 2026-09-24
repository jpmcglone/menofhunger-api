import { BadRequestException, ServiceUnavailableException, type ArgumentsHost } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { ApiExceptionFilter } from './api-exception.filter';

jest.mock('@sentry/nestjs', () => {
  const scope = { setTag: jest.fn(), setUser: jest.fn() };
  return {
    scope,
    captureException: jest.fn(),
    withScope: jest.fn((fn: (s: typeof scope) => void) => fn(scope)),
  };
});

const scope = (Sentry as unknown as { scope: { setTag: jest.Mock; setUser: jest.Mock } }).scope;

function hostFor(user?: { id: string }) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const req = { requestId: 'req_1', headers: {}, user };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as unknown as ArgumentsHost;
  return { host, res };
}

describe('ApiExceptionFilter Sentry reporting', () => {
  const filter = new ApiExceptionFilter();
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  beforeEach(() => jest.clearAllMocks());
  afterAll(() => consoleError.mockRestore());

  it('reports unexpected errors with the member and request id', () => {
    const { host, res } = hostFor({ id: 'user_1' });
    const error = new Error('db down');

    filter.catch(error, host);

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(scope.setUser).toHaveBeenCalledWith({ id: 'user_1' });
    expect(scope.setTag).toHaveBeenCalledWith('request_id', 'req_1');
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('reports intentional 5xx responses', () => {
    const { host } = hostFor();

    filter.catch(new ServiceUnavailableException(), host);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(scope.setUser).not.toHaveBeenCalled();
  });

  it('does not report client errors', () => {
    const { host, res } = hostFor({ id: 'user_1' });

    filter.catch(new BadRequestException('nope'), host);

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
