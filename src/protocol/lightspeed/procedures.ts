import { I64, type LsValue, type ProcedureCall } from "./decoder.js";

/**
 * Positional field maps for the Lightspeed stored procedures this library consumes.
 *
 * Source: mautrix/meta table/*.go @ e012f9f8 (protocol-status.md §5–§6). THIS IS THE
 * VOLATILE PART OF THE PROTOCOL: when Meta changes a schema, edit it here and nowhere else.
 * Only fields the library uses are listed; every other argument is counted as
 * "unrecognized" (never guessed), which makes schema drift visible.
 *
 * Field kinds: "string" → string, "i64" → exact decimal string, "bool" → boolean.
 */
type FieldKind = "string" | "i64" | "bool";
type Schema = Readonly<Record<string, readonly [index: number, kind: FieldKind]>>;

const s = (index: number) => [index, "string"] as const;
const i = (index: number) => [index, "i64"] as const;
const b = (index: number) => [index, "bool"] as const;

/** Fields shared by insertMessage and upsertMessage (same positions). */
const MESSAGE = {
  text: s(0),
  threadKey: i(3),
  timestampMs: i(5),
  messageId: s(8),
  offlineThreadingId: s(9),
  senderId: i(10),
  stickerId: i(11),
  isAdminMessage: b(12),
  isUnsent: b(17),
  mentionOffsets: s(19),
  mentionLengths: s(20),
  mentionIds: s(21),
  mentionTypes: s(22),
  replySourceId: s(23),
  replySnippet: s(27),
  replyMessageText: s(28),
  replyToUserId: i(29),
  isForwarded: b(43),
  editCount: i(68),
} as const;

export const PROCEDURE_SCHEMAS = {
  insertMessage: MESSAGE,
  upsertMessage: MESSAGE,
  /** Same fields, but positions shift from index 42 on (protocol-status.md §6). */
  deleteThenInsertMessage: { ...MESSAGE, isForwarded: b(42), editCount: i(67) },
  editMessage: { messageId: s(0), authorityLevel: i(1), text: s(2), editCount: i(3) },
  deleteMessage: { threadKey: i(0), messageId: s(1) },
  upsertReaction: {
    threadKey: i(0),
    timestampMs: i(1),
    messageId: s(2),
    actorId: i(3),
    reaction: s(4),
    authorityLevel: i(5),
  },
  deleteReaction: { threadKey: i(0), messageId: s(1), actorId: i(2) },
  updateTypingIndicator: { threadKey: i(0), senderId: i(1), isTyping: b(2) },
  executeFirstBlockForSyncTransaction: {
    databaseId: i(0),
    epochId: i(1),
    currentCursor: s(2),
    nextCursor: s(3),
    syncStatus: i(4),
    sendSyncParams: b(5),
    syncChannel: i(8),
  },
  executeFirstBlockForSyncTransactionV4: {
    databaseId: i(0),
    epochId: i(1),
    currentCursor: s(2),
    nextCursor: s(3),
    currentSeqId: i(4),
    syncStatus: i(5),
    sendSyncParams: b(6),
    syncChannel: i(9),
  },
} as const satisfies Record<string, Schema>;

export type ProcedureName = keyof typeof PROCEDURE_SCHEMAS;

type ValueOf<K extends FieldKind> = K extends "bool" ? boolean : string;
export type RowOf<N extends ProcedureName> = {
  readonly [F in keyof (typeof PROCEDURE_SCHEMAS)[N]]?: (typeof PROCEDURE_SCHEMAS)[N][F] extends readonly [
    number,
    infer K extends FieldKind,
  ]
    ? ValueOf<K>
    : never;
};

export type ParsedCall =
  | {
      readonly [N in ProcedureName]: {
        readonly procedure: N;
        readonly row: RowOf<N>;
        /** Count of non-empty arguments at positions this schema does not map. */
        readonly unrecognizedArgs: number;
        /** Field names whose argument had an unexpected type (left unset, never coerced). */
        readonly typeMismatches: readonly string[];
      };
    }[ProcedureName]
  | { readonly procedure: string; readonly unknown: true };

export function isKnownProcedure(name: string): name is ProcedureName {
  return Object.prototype.hasOwnProperty.call(PROCEDURE_SCHEMAS, name);
}

/** Maps a decoded procedure call onto its typed row, without guessing at any value. */
export function parseProcedureCall(call: ProcedureCall): ParsedCall {
  if (!isKnownProcedure(call.name)) return { procedure: call.name, unknown: true };
  const schema: Schema = PROCEDURE_SCHEMAS[call.name];
  const row: Record<string, string | boolean> = {};
  const typeMismatches: string[] = [];
  const mapped = new Set<number>();

  for (const [field, [index, kind]] of Object.entries(schema)) {
    mapped.add(index);
    const raw = call.args[index];
    if (raw === undefined || raw === null) continue;
    const value = convert(raw, kind);
    if (value === undefined) typeMismatches.push(field);
    else row[field] = value;
  }

  let unrecognizedArgs = 0;
  call.args.forEach((arg, index) => {
    if (!mapped.has(index) && arg !== undefined && arg !== null) unrecognizedArgs++;
  });

  return { procedure: call.name, row, unrecognizedArgs, typeMismatches } as ParsedCall;
}

function convert(value: LsValue, kind: FieldKind): string | boolean | undefined {
  switch (kind) {
    case "string":
      return typeof value === "string" ? value : undefined;
    case "bool":
      return typeof value === "boolean" ? value : undefined;
    case "i64":
      if (value instanceof I64) return value.value;
      // A plain JSON number is accepted only when it is an exact (safe) integer.
      if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
      return undefined;
  }
}
