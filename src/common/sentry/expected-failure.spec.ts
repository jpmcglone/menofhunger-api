import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { isExpectedFailure } from './expected-failure';

describe('isExpectedFailure', () => {
  it('drops deliberate client errors that already reach the user', () => {
    expect(isExpectedFailure(new BadRequestException('Pick a shorter name.'))).toBe(true);
    expect(isExpectedFailure(new UnauthorizedException())).toBe(true);
    expect(isExpectedFailure(new NotFoundException())).toBe(true);
  });

  it('drops the 503 we return while an upstream provider is briefly unavailable', () => {
    expect(isExpectedFailure(new ServiceUnavailableException('Try again in a moment.'))).toBe(true);
  });

  it('reports a 500 we raised ourselves — our own code hit a state it could not handle', () => {
    expect(isExpectedFailure(new InternalServerErrorException('Unreachable branch'))).toBe(false);
  });

  it('reports unexpected runtime failures', () => {
    expect(isExpectedFailure(new TypeError('x is not a function'))).toBe(false);
    expect(isExpectedFailure(new Error('boom'))).toBe(false);
    expect(isExpectedFailure(null)).toBe(false);
    expect(isExpectedFailure('boom')).toBe(false);
  });

  it('reports an exception whose status is not a number', () => {
    expect(isExpectedFailure({ getStatus: () => 'nonsense' })).toBe(false);
  });

  it('drops third-party Pickax rejections, which the queue retries and Settings shows', () => {
    class PickaxApiError extends Error {}
    expect(isExpectedFailure(new PickaxApiError('Pickax responded with 500.'))).toBe(true);
  });
});
