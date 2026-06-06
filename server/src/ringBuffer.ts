/** Fixed-size in-memory ring buffer. Live-only system: no persistence. */
export class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }
  }

  snapshot(): T[] {
    return this.buf.slice();
  }

  get size(): number {
    return this.buf.length;
  }
}
