import { ServiceUnavailableException } from '@nestjs/common';

/** Admit work before downloading image bytes. Waiting requests retain no image buffers. */
export class ImageProcessingGate {
  private active = false;
  private readonly waiting: Array<() => void> = [];

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active) {
      if (this.waiting.length >= 8) throw this.busy();
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.waiting.indexOf(start);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(this.busy());
        }, 15_000);
        this.waiting.push(start);
      });
    } else {
      this.active = true;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active = false;
    }
  }

  private busy() {
    return new ServiceUnavailableException('Image uploads are busy. Please try again in a moment.');
  }
}
