/**
 * DGW (gateway.facebook.com) binary frame codec.
 *
 * Layouts per docs/research/protocol-status.md §3.2. All integers are little-endian;
 * `u24` lengths count the bytes that follow the 6-byte header. One WebSocket message may
 * carry several concatenated frames. Pure functions: no I/O, no state.
 */

export const FrameType = {
  Drain: 3,
  Deauth: 4,
  Ping: 9,
  Pong: 10,
  Ack: 12,
  Data: 13,
  EndOfData: 14,
  EstablishStream: 15,
  EndOfDataWithReason: 16,
  ExtendedData: 17,
} as const;

export const MAX_STREAM_ID = 0xffff;
export const MAX_ACK_ID = 0x7fff;
const REQUIRES_ACK_BIT = 0x8000;
const MAX_U24 = 0xffffff;

export type DgwFrame =
  | { readonly type: "drain"; readonly reason: number }
  | { readonly type: "deauth" }
  | { readonly type: "ping" }
  | { readonly type: "pong" }
  | { readonly type: "ack"; readonly streamId: number; readonly ackId: number }
  | {
      readonly type: "data";
      readonly streamId: number;
      readonly ackId: number;
      readonly requiresAck: boolean;
      readonly payload: Uint8Array;
      /** Present only for the extended data frame type (17). */
      readonly contentType?: number;
    }
  | { readonly type: "endOfData"; readonly streamId: number; readonly reason?: number }
  | { readonly type: "establish"; readonly streamId: number; readonly parameters: string };

export interface DecodedMessage {
  readonly frames: readonly DgwFrame[];
  /**
   * Set when decoding stopped early: an unknown frame type (its length cannot be known,
   * so the rest of the message is dropped) or a truncated/invalid frame.
   */
  readonly stopped?: {
    readonly kind: "unsupported" | "malformed";
    readonly frameType: number;
    readonly offset: number;
    readonly droppedBytes: number;
    readonly detail: string;
  };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** Encodes frames into one WebSocket message. */
export function encodeFrames(frames: readonly DgwFrame[]): Uint8Array {
  const parts = frames.map(encodeFrame);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function encodeFrame(frame: DgwFrame): Uint8Array {
  switch (frame.type) {
    case "ping":
      return Uint8Array.of(FrameType.Ping);
    case "pong":
      return Uint8Array.of(FrameType.Pong);
    case "deauth":
      return Uint8Array.of(FrameType.Deauth);
    case "drain":
      return Uint8Array.of(FrameType.Drain, 1, 0, 0, byte(frame.reason, "drain reason"));
    case "ack": {
      const out = header(FrameType.Ack, frame.streamId, 2);
      writeU16(out, 6, ackId(frame.ackId));
      return out;
    }
    case "data": {
      const extended = frame.contentType !== undefined;
      const headerBytes = extended ? 3 : 2;
      const out = header(
        extended ? FrameType.ExtendedData : FrameType.Data,
        frame.streamId,
        headerBytes + frame.payload.length,
        frame.payload.length,
      );
      writeU16(out, 6, ackId(frame.ackId) | (frame.requiresAck ? REQUIRES_ACK_BIT : 0));
      if (extended) out[8] = byte(frame.contentType, "content type");
      out.set(frame.payload, 6 + headerBytes);
      return out;
    }
    case "endOfData": {
      if (frame.reason === undefined) {
        const out = new Uint8Array(3);
        out[0] = FrameType.EndOfData;
        writeU16(out, 1, streamId(frame.streamId));
        return out;
      }
      const out = header(FrameType.EndOfDataWithReason, frame.streamId, 1);
      out[6] = byte(frame.reason, "end-of-data reason");
      return out;
    }
    case "establish": {
      const params = textEncoder.encode(frame.parameters);
      const out = header(FrameType.EstablishStream, frame.streamId, params.length, params.length);
      out.set(params, 6);
      return out;
    }
  }
}

/** Decodes every frame in one WebSocket message, stopping safely at the first unknown or invalid frame. */
export function decodeFrames(message: Uint8Array): DecodedMessage {
  const frames: DgwFrame[] = [];
  let offset = 0;
  const stop = (kind: "unsupported" | "malformed", frameType: number, detail: string): DecodedMessage => ({
    frames,
    stopped: { kind, frameType, offset, droppedBytes: message.length - offset, detail },
  });

  while (offset < message.length) {
    const type = message[offset] as number;
    const remaining = message.length - offset;
    switch (type) {
      case FrameType.Ping:
      case FrameType.Pong:
      case FrameType.Deauth:
        frames.push({ type: type === FrameType.Ping ? "ping" : type === FrameType.Pong ? "pong" : "deauth" });
        offset += 1;
        break;

      case FrameType.Drain: {
        if (remaining < 5) return stop("malformed", type, "drain frame truncated");
        if (readU24(message, offset + 1) !== 1) return stop("malformed", type, "drain frame length is not 1");
        frames.push({ type: "drain", reason: message[offset + 4] as number });
        offset += 5;
        break;
      }

      case FrameType.EndOfData: {
        if (remaining < 3) return stop("malformed", type, "end-of-data frame truncated");
        frames.push({ type: "endOfData", streamId: readU16(message, offset + 1) });
        offset += 3;
        break;
      }

      case FrameType.Ack:
      case FrameType.Data:
      case FrameType.ExtendedData:
      case FrameType.EstablishStream:
      case FrameType.EndOfDataWithReason: {
        if (remaining < 6) return stop("malformed", type, "frame header truncated");
        const sid = readU16(message, offset + 1);
        const length = readU24(message, offset + 3);
        if (remaining < 6 + length)
          return stop("malformed", type, `frame body truncated (needs ${length} bytes)`);
        const body = message.subarray(offset + 6, offset + 6 + length);

        if (type === FrameType.Ack) {
          if (length !== 2) return stop("malformed", type, "ack frame length is not 2");
          frames.push({ type: "ack", streamId: sid, ackId: readU16(body, 0) });
        } else if (type === FrameType.Data || type === FrameType.ExtendedData) {
          const extended = type === FrameType.ExtendedData;
          const headerBytes = extended ? 3 : 2;
          if (length < headerBytes) return stop("malformed", type, "data frame too short");
          const ackField = readU16(body, 0);
          frames.push({
            type: "data",
            streamId: sid,
            ackId: ackField & MAX_ACK_ID,
            requiresAck: (ackField & REQUIRES_ACK_BIT) !== 0,
            payload: body.slice(headerBytes),
            ...(extended ? { contentType: body[2] as number } : {}),
          });
        } else if (type === FrameType.EstablishStream) {
          frames.push({ type: "establish", streamId: sid, parameters: textDecoder.decode(body) });
        } else {
          if (length < 1) return stop("malformed", type, "end-of-data-with-reason frame has no reason");
          frames.push({ type: "endOfData", streamId: sid, reason: body[0] as number });
        }
        offset += 6 + length;
        break;
      }

      default:
        return stop("unsupported", type, `unknown frame type ${type}`);
    }
  }
  return { frames };
}

function header(type: number, sid: number, length: number, payloadBytes = 0): Uint8Array {
  if (length > MAX_U24 || payloadBytes > MAX_U24) throw new RangeError("DGW frame too large");
  const out = new Uint8Array(6 + length);
  out[0] = type;
  writeU16(out, 1, streamId(sid));
  out[3] = length & 0xff;
  out[4] = (length >>> 8) & 0xff;
  out[5] = (length >>> 16) & 0xff;
  return out;
}

function streamId(id: number): number {
  if (!Number.isInteger(id) || id < 0 || id > MAX_STREAM_ID)
    throw new RangeError(`invalid DGW stream id ${id}`);
  return id;
}

function ackId(id: number): number {
  if (!Number.isInteger(id) || id < 0 || id > MAX_ACK_ID) throw new RangeError(`invalid DGW ack id ${id}`);
  return id;
}

function byte(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff)
    throw new RangeError(`invalid DGW ${what} ${value}`);
  return value;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function readU16(source: Uint8Array, offset: number): number {
  return (source[offset] as number) | ((source[offset + 1] as number) << 8);
}

function readU24(source: Uint8Array, offset: number): number {
  return (
    (source[offset] as number) |
    ((source[offset + 1] as number) << 8) |
    ((source[offset + 2] as number) << 16)
  );
}

/** Close codes used by the gateway (protocol-status.md §3.1). */
export const DgwCloseCode = {
  GracefulClose: 4000,
  KeepaliveTimeout: 4001,
  ServerError: 4002,
  Unauthorized: 4003,
  Rejected: 4004,
  BadRequest: 4005,
} as const;
