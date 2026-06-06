import { describe, it, expect } from "vitest";
import { RingBuffer } from "../src/ringBuffer.js";

describe("RingBuffer", () => {
  it("stores items up to capacity", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    expect(rb.snapshot()).toEqual([1, 2]);
    expect(rb.size).toBe(2);
  });

  it("drops oldest items beyond capacity (FIFO)", () => {
    const rb = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) rb.push(n);
    expect(rb.snapshot()).toEqual([3, 4, 5]);
    expect(rb.size).toBe(3);
  });

  it("snapshot returns a copy (not a live reference)", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    const snap = rb.snapshot();
    rb.push(2);
    expect(snap).toEqual([1]); // unaffected by later push
  });

  it("handles capacity of 1", () => {
    const rb = new RingBuffer<string>(1);
    rb.push("a");
    rb.push("b");
    expect(rb.snapshot()).toEqual(["b"]);
  });
});
