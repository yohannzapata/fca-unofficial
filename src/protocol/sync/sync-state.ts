/**
 * Per-database Lightspeed sync state (protocol-status.md §3.5).
 *
 * Each sync database keeps a `last_applied_cursor`. Sending the stored cursor makes the
 * server return changes since it, which is how gaps after a disconnect are filled.
 */

/** Databases synced on every (re)connect by the reference client. */
export const SYNC_DATABASES = [1, 2, 95, 104] as const;
export type SyncDatabaseId = (typeof SYNC_DATABASES)[number];

/** Sync channels select which page-provided sync params a type-1 query carries. */
export const SyncChannel = { Mailbox: 1, Contact: 2 } as const;

export interface SyncDatabaseState {
  /** Opaque server cursor; null before the first successful sync. */
  readonly cursor: string | null;
  /** true → type-1 query with sync_params; false → type-2 query with last_applied_cursor. */
  readonly sendSyncParams: boolean;
  readonly syncChannel: number;
}

export type SyncStateMap = Readonly<Record<number, SyncDatabaseState>>;

/** Initial per-database settings used by the reference client (messagix syncManager). */
export const INITIAL_SYNC_STATE: SyncStateMap = Object.freeze({
  1: { cursor: null, sendSyncParams: false, syncChannel: SyncChannel.Mailbox },
  2: { cursor: null, sendSyncParams: true, syncChannel: SyncChannel.Contact },
  95: { cursor: null, sendSyncParams: false, syncChannel: SyncChannel.Contact },
  104: { cursor: null, sendSyncParams: true, syncChannel: 0 },
});

export interface PageSyncParams {
  readonly mailbox?: string;
  readonly contact?: string;
  readonly e2ee?: string;
}

/** Which sync-params string a database sends: by channel (mailbox, contact), else e2ee. */
export function syncParamsFor(
  state: SyncDatabaseState,
  params: PageSyncParams | undefined,
): string | undefined {
  if (state.syncChannel === SyncChannel.Mailbox) return params?.mailbox;
  if (state.syncChannel === SyncChannel.Contact) return params?.contact;
  return params?.e2ee;
}

/** Fields of an executeFirstBlockForSyncTransaction(V4) row that drive cursor updates. */
export interface FirstBlock {
  readonly databaseId?: string;
  readonly currentCursor?: string;
  readonly nextCursor?: string;
  readonly sendSyncParams?: boolean;
  readonly syncChannel?: string;
}

const NO_CURSOR = new Set(["", "dummy_cursor"]);

/**
 * Applies a first-block row. Returns the new state and whether the cursor advanced (in
 * which case a sync should be repeated from the new cursor). A cursor that is empty,
 * "dummy_cursor", equal to the current one, or equal to the previous one does not advance.
 */
export function applyFirstBlock(
  state: SyncDatabaseState,
  block: FirstBlock,
): { state: SyncDatabaseState; advanced: boolean } {
  const next = block.nextCursor;
  const advanced =
    next !== undefined && !NO_CURSOR.has(next) && next !== block.currentCursor && next !== state.cursor;
  const syncChannel = block.syncChannel === undefined ? state.syncChannel : Number(block.syncChannel);
  return {
    advanced,
    state: {
      cursor: advanced ? next : state.cursor,
      sendSyncParams: block.sendSyncParams ?? state.sendSyncParams,
      syncChannel: Number.isSafeInteger(syncChannel) ? syncChannel : state.syncChannel,
    },
  };
}

/** Merges stored state over the defaults, keeping only the known databases. */
export function restoreSyncState(stored: SyncStateMap | undefined): Record<number, SyncDatabaseState> {
  const out: Record<number, SyncDatabaseState> = {};
  for (const db of SYNC_DATABASES) {
    const base = INITIAL_SYNC_STATE[db] as SyncDatabaseState;
    const saved = stored?.[db];
    out[db] = saved ? { ...base, ...saved } : base;
  }
  return out;
}
