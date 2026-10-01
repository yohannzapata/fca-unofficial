/**
 * Lightspeed payload decoder (protocol-status.md §5).
 *
 * A Lightspeed payload is `{ "name": string, "step": Step }` where a step is an array
 * `[opcode, ...operands]`. The server uses it as a tiny program whose effect is a sequence
 * of stored-procedure calls (`[5, "insertMessage", ...args]`). We do not emulate a database:
 * we evaluate just enough of the program to recover those calls, in order.
 *
 * Opcode semantics follow the reference decoder (mautrix/meta lightspeed/decode.go
 * @ e012f9f8), with one deliberate difference: an `IF` whose condition cannot be evaluated
 * skips both branches and is counted, instead of guessing. Unsupported opcodes evaluate to
 * `undefined` and are counted per opcode, so drift is visible in diagnostics.
 */

/** A 64-bit integer, kept as exact decimal text (values routinely exceed 2^53). */
export class I64 {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type LsValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | I64
  | Uint8Array
  | readonly LsValue[]
  | { readonly [key: string]: LsValue };

export interface ProcedureCall {
  readonly name: string;
  readonly args: readonly LsValue[];
}

export interface DecodeStats {
  procedureCalls: number;
  /** opcode → occurrences of opcodes this decoder does not evaluate. */
  readonly unsupportedOps: Record<number, number>;
  /** IF steps skipped because their condition could not be evaluated. */
  skippedBranches: number;
  /** Malformed steps (wrong operand types, excessive depth). */
  malformed: number;
}

export interface DecodedPayload {
  readonly name: string | undefined;
  readonly calls: readonly ProcedureCall[];
  readonly stats: DecodeStats;
}

const Op = {
  BLOCK: 1,
  LOAD: 2,
  STORE: 3,
  CALL_STORED_PROCEDURE: 5,
  UNDEFINED: 9,
  TO_BLOB: 16,
  I64_FROM_STRING: 19,
  IF: 23,
  I64_EQUAL: 30,
  LOG_CONSOLE: 48,
  LOGGER_LOG: 49,
  ARRAY_CREATE: 50,
  ARRAY_APPEND: 51,
  ARRAY_GET_SIZE: 52,
  MAP_CREATE: 53,
  MAP_SET: 55,
  CURRENT_TIME: 60,
  I64_ADD: 69,
} as const;

const MAX_DEPTH = 256;
const I64_TEXT = /^-?\d{1,20}$/;

/** Decodes the JSON text of a Lightspeed payload. Throws only if the text is not JSON. */
export function decodeLightspeedPayload(payloadJson: string): DecodedPayload {
  const parsed: unknown = JSON.parse(payloadJson);
  const name =
    typeof parsed === "object" && parsed !== null && typeof (parsed as { name?: unknown }).name === "string"
      ? (parsed as { name: string }).name
      : undefined;
  const step =
    typeof parsed === "object" && parsed !== null ? (parsed as { step?: unknown }).step : undefined;
  return { name, ...decodeSteps(step) };
}

/** Evaluates a step tree and returns the stored-procedure calls it performs, in order. */
export function decodeSteps(step: unknown): { calls: ProcedureCall[]; stats: DecodeStats } {
  const calls: ProcedureCall[] = [];
  const stats: DecodeStats = { procedureCalls: 0, unsupportedOps: {}, skippedBranches: 0, malformed: 0 };
  const references = new Map<number, LsValue>();

  const evaluate = (value: unknown, depth: number): LsValue => {
    if (depth > MAX_DEPTH) {
      stats.malformed++;
      return undefined;
    }
    if (!Array.isArray(value)) return literal(value);
    const [opcode, ...operands] = value as unknown[];
    if (typeof opcode !== "number") return literal(value);

    switch (opcode) {
      case Op.BLOCK:
        for (const child of operands) evaluate(child, depth + 1);
        return undefined;
      case Op.LOAD:
        return typeof operands[0] === "number" ? references.get(operands[0]) : malformed();
      case Op.STORE:
        if (typeof operands[0] !== "number") return malformed();
        references.set(operands[0], evaluate(operands[1], depth + 1));
        return undefined;
      case Op.CALL_STORED_PROCEDURE: {
        const name = operands[0];
        if (typeof name !== "string") return malformed();
        calls.push({ name, args: operands.slice(1).map((arg) => evaluate(arg, depth + 1)) });
        stats.procedureCalls++;
        return undefined;
      }
      case Op.UNDEFINED:
        return undefined;
      case Op.I64_FROM_STRING:
        return typeof operands[0] === "string" && I64_TEXT.test(operands[0])
          ? new I64(operands[0])
          : malformed();
      case Op.TO_BLOB:
        return typeof operands[0] === "string"
          ? Uint8Array.from(Buffer.from(operands[0], "base64"))
          : malformed();
      case Op.IF: {
        const condition = truthiness(evaluate(operands[0], depth + 1));
        if (condition === undefined) {
          stats.skippedBranches++;
          return undefined;
        }
        if (condition) evaluate(operands[1], depth + 1);
        else if (operands[2] !== undefined && operands[2] !== null) evaluate(operands[2], depth + 1);
        return undefined;
      }
      case Op.I64_EQUAL: {
        const a = evaluate(operands[0], depth + 1);
        const b = evaluate(operands[1], depth + 1);
        return a instanceof I64 && b instanceof I64 ? a.value === b.value : malformed();
      }
      case Op.I64_ADD: {
        const a = evaluate(operands[0], depth + 1);
        const b = evaluate(operands[1], depth + 1);
        return a instanceof I64 && b instanceof I64
          ? new I64((BigInt(a.value) + BigInt(b.value)).toString())
          : malformed();
      }
      case Op.CURRENT_TIME:
        return new I64(String(Date.now()));
      case Op.LOG_CONSOLE:
      case Op.LOGGER_LOG:
        return undefined;
      case Op.ARRAY_CREATE:
        return [];
      case Op.ARRAY_APPEND: {
        const array = evaluate(operands[0], depth + 1);
        return Array.isArray(array)
          ? [...(array as LsValue[]), evaluate(operands[1], depth + 1)]
          : malformed();
      }
      case Op.ARRAY_GET_SIZE: {
        const array = evaluate(operands[0], depth + 1);
        return Array.isArray(array) ? array.length : malformed();
      }
      case Op.MAP_CREATE:
        return {};
      case Op.MAP_SET: {
        const map = evaluate(operands[0], depth + 1);
        const key = evaluate(operands[1], depth + 1);
        const keyText =
          typeof key === "string"
            ? key
            : key instanceof I64
              ? key.value
              : typeof key === "number"
                ? String(key)
                : undefined;
        if (
          keyText === undefined ||
          typeof map !== "object" ||
          map === null ||
          Array.isArray(map) ||
          map instanceof I64 ||
          map instanceof Uint8Array
        ) {
          return malformed();
        }
        (map as Record<string, LsValue>)[keyText] = evaluate(operands[2], depth + 1);
        return undefined;
      }
      default:
        stats.unsupportedOps[opcode] = (stats.unsupportedOps[opcode] ?? 0) + 1;
        return undefined;
    }
  };

  const malformed = (): LsValue => {
    stats.malformed++;
    return undefined;
  };

  evaluate(step, 0);
  return { calls, stats };
}

function literal(value: unknown): LsValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

/** true/false when the condition is definite; undefined when it cannot be evaluated. */
function truthiness(value: LsValue): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (value instanceof I64) return BigInt(value.value) > 0n;
  return undefined;
}
