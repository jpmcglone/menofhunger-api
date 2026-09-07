import { ServiceUnavailableException } from '@nestjs/common';
import { ImageProcessingGate } from './image-processing-gate';

describe('ImageProcessingGate', () => {
  afterEach(() => jest.useRealTimers());

  it('serializes work and releases the slot after failure', async () => {
    const gate = new ImageProcessingGate();
    let release!: () => void;
    const started: number[] = [];
    const first = gate.run(async () => {
      started.push(1);
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error('decode failed');
    });
    const failed = expect(first).rejects.toThrow('decode failed');
    const second = gate.run(async () => { started.push(2); return 'ok'; });
    expect(started).toEqual([1]);
    release();
    await failed;
    await expect(second).resolves.toBe('ok');
    expect(started).toEqual([1, 2]);
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });

  it('bounds the waiting queue without starting rejected work', async () => {
    const gate = new ImageProcessingGate();
    let release!: () => void;
    const first = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const queued = Array.from({ length: 8 }, () => gate.run(async () => undefined));
    const rejected = jest.fn();
    await expect(gate.run(rejected)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(rejected).not.toHaveBeenCalled();
    release();
    await Promise.all([first, ...queued]);
  });

  it('expires queued work without admitting another concurrent job', async () => {
    jest.useFakeTimers();
    const gate = new ImageProcessingGate();
    let release!: () => void;
    const first = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const work = jest.fn();
    const timedOut = expect(gate.run(work)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await jest.advanceTimersByTimeAsync(15_000);
    await timedOut;
    expect(work).not.toHaveBeenCalled();
    const next = gate.run(async () => 'ok');
    release();
    await first;
    await expect(next).resolves.toBe('ok');
  });
});
