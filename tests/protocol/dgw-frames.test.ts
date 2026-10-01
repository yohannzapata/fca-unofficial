import { describe, expect, it } from "vitest";
import {
  decodeFrames,
  type DgwFrame,
  encodeFrame,
  encodeFrames,
  FrameType,
} from "../../src/transport/dgw/frames.js";

const bytes = (...values: number[]) => Uint8Array.from(values);
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("DGW frame codec — byte layouts (protocol-status.md §3.2)", () => {
  it("encodes single-byte control frames", () => {
    expect(encodeFrame({ type: "ping" })).toEqual(bytes(9));
    expect(encodeFrame({ type: "pong" })).toEqual(bytes(10));
    expect(encodeFrame({ type: "deauth" })).toEqual(bytes(4));
  });

  it("encodes drain: type, u24 len=1, reason", () => {
    expect(encodeFrame({ type: "drain", reason: 5 })).toEqual(bytes(3, 1, 0, 0, 5));
  });

  it("encodes ack: type, stream u16 LE, u24 len=2, ack id u16 LE", () => {
    expect(encodeFrame({ type: "ack", streamId: 0x0102, ackId: 0x0304 })).toEqual(
      bytes(12, 0x02, 0x01, 2, 0, 0, 0x04, 0x03),
    );
  });

  it("encodes data with the requires-ack bit in the top bit of the ack field", () => {
    const frame = encodeFrame({
      type: "data",
      streamId: 1,
      ackId: 7,
      requiresAck: true,
      payload: utf8("hi"),
    });
    // len = 2 (ack field) + 2 (payload); ack field 0x0007 | 0x8000 → LE 07 80
    expect(frame).toEqual(bytes(13, 1, 0, 4, 0, 0, 0x07, 0x80, 0x68, 0x69));
    const noAck = encodeFrame({
      type: "data",
      streamId: 1,
      ackId: 7,
      requiresAck: false,
      payload: utf8("hi"),
    });
    expect(noAck[7]).toBe(0x00);
  });

  it("encodes extended data with a content-type byte", () => {
    const frame = encodeFrame({
      type: "data",
      streamId: 2,
      ackId: 0,
      requiresAck: false,
      payload: utf8("x"),
      contentType: 9,
    });
    expect(frame).toEqual(bytes(17, 2, 0, 4, 0, 0, 0, 0, 9, 0x78));
  });

  it("encodes establish with JSON parameters and both end-of-data variants", () => {
    expect(encodeFrame({ type: "establish", streamId: 3, parameters: "{}" })).toEqual(
      bytes(15, 3, 0, 2, 0, 0, 0x7b, 0x7d),
    );
    expect(encodeFrame({ type: "endOfData", streamId: 0x0203 })).toEqual(bytes(14, 0x03, 0x02));
    expect(encodeFrame({ type: "endOfData", streamId: 1, reason: 8 })).toEqual(bytes(16, 1, 0, 1, 0, 0, 8));
  });

  it("round-trips every frame type, concatenated in one message", () => {
    const frames: DgwFrame[] = [
      { type: "ping" },
      { type: "pong" },
      { type: "deauth" },
      { type: "drain", reason: 2 },
      { type: "ack", streamId: 65535, ackId: 0x7fff },
      { type: "data", streamId: 4, ackId: 12, requiresAck: true, payload: utf8('{"a":1}') },
      { type: "data", streamId: 4, ackId: 0, requiresAck: false, payload: utf8(""), contentType: 1 },
      { type: "establish", streamId: 5, parameters: '{"code":200}' },
      { type: "endOfData", streamId: 6 },
      { type: "endOfData", streamId: 7, reason: 4 },
    ];
    const decoded = decodeFrames(encodeFrames(frames));
    expect(decoded.stopped).toBeUndefined();
    expect(decoded.frames).toEqual(frames);
  });

  it("handles payloads larger than 64 KiB (u24 lengths)", () => {
    const payload = new Uint8Array(200_000).fill(0x41);
    const decoded = decodeFrames(
      encodeFrame({ type: "data", streamId: 1, ackId: 1, requiresAck: true, payload }),
    );
    expect(decoded.frames[0]).toMatchObject({ type: "data", payload });
  });

  it("stops at an unknown frame type, keeping earlier frames and reporting dropped bytes", () => {
    const message = Uint8Array.from([...encodeFrame({ type: "ping" }), 99, 1, 2, 3]);
    const decoded = decodeFrames(message);
    expect(decoded.frames).toEqual([{ type: "ping" }]);
    expect(decoded.stopped).toMatchObject({ kind: "unsupported", frameType: 99, offset: 1, droppedBytes: 4 });
  });

  it("reports truncated frames as malformed instead of reading past the end", () => {
    const full = encodeFrame({
      type: "data",
      streamId: 1,
      ackId: 1,
      requiresAck: false,
      payload: utf8("hello"),
    });
    const decoded = decodeFrames(full.subarray(0, full.length - 2));
    expect(decoded.frames).toEqual([]);
    expect(decoded.stopped).toMatchObject({ kind: "malformed", frameType: FrameType.Data });
    expect(decodeFrames(bytes(12, 1, 0, 3, 0, 0, 0, 0, 0)).stopped?.detail).toMatch(/ack frame length/);
    expect(decodeFrames(bytes(3, 2, 0, 0, 1)).stopped?.detail).toMatch(/drain frame length/);
  });

  it("rejects out-of-range ids when encoding", () => {
    expect(() => encodeFrame({ type: "ack", streamId: 70_000, ackId: 1 })).toThrow(RangeError);
    expect(() => encodeFrame({ type: "ack", streamId: 1, ackId: 0x8000 })).toThrow(RangeError);
  });
});
