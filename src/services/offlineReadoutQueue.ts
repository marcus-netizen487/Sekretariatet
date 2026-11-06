import type {
  CardPunch,
  Competitor,
  FullCardReadoutPayload,
  LiveEventItem,
  RunnerDbEntry,
  StationFunction,
} from '../types/sportident';
import { submitOnlinePunchToFirestore, submitReadoutToFirestore } from '../firebase';

export interface QueuedReadoutItem {
  id: string;
  kind: 'READOUT' | 'ONLINE_PUNCH';
  createdAt: string;
  eventId?: string;
  readoutPayload?: FullCardReadoutPayload;
  onlinePunchPayload?: {
    clientPunchId: string;
    siNumber: number;
    stationCode: number;
    punchTimeSec?: number;
    rawHex?: string;
    stationName?: string;
    stationFunction?: StationFunction;
    timeOffsetSec?: number;
  };
}

export interface ReadoutDeliveryResult {
  queuedOffline: boolean;
  competitor?: Competitor | null;
  event?: LiveEventItem;
  suggestedRunner?: RunnerDbEntry | null;
  unknownCardReadout?: {
    siNumber: number;
    checkTimeSec?: number | null;
    startTimeSec?: number | null;
    finishTimeSec?: number | null;
    punches?: CardPunch[];
  };
}

export interface OfflineQueueSnapshot {
  pendingItems: QueuedReadoutItem[];
  simulatedOffline: boolean;
  browserOnline: boolean;
  flushing: boolean;
  lastError: string | null;
  totalSyncedSession: number;
  lastSyncedAt: string | null;
}

const STORAGE_KEY = 'passersi_offline_readout_queue_v1';
const SIM_OFFLINE_KEY = 'passersi_simulate_offline_forest';
const IDB_NAME = 'PasserSI_ForestQueueDB';
const IDB_STORE = 'pending_readouts';
const DELIVERY_TIMEOUT_MS = 30_000;
const INITIAL_RETRY_DELAY_MS = 4_000;
const MAX_RETRY_DELAY_MS = 60_000;

type SnapshotListener = (snap: OfflineQueueSnapshot) => void;
type SyncedResultListener = (res: ReadoutDeliveryResult) => void;

class OfflineReadoutQueueManager {
  private items: QueuedReadoutItem[] = [];
  private simulatedOffline = false;
  private browserOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private flushing = false;
  private lastError: string | null = null;
  private totalSyncedSession = 0;
  private lastSyncedAt: string | null = null;
  private listeners = new Set<SnapshotListener>();
  private syncedListeners = new Set<SyncedResultListener>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private retryDelayMs = INITIAL_RETRY_DELAY_MS;
  private nextRetryAt = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      this.items = this.loadFromLocalStorage();
      this.simulatedOffline = localStorage.getItem(SIM_OFFLINE_KEY) === 'true';

      window.addEventListener('online', () => {
        this.browserOnline = true;
        this.emit();
        void this.flushQueue();
      });
      window.addEventListener('offline', () => {
        this.browserOnline = false;
        this.emit();
      });

      void this.reconcileWithIndexedDb();

      this.retryTimer = setInterval(() => {
        if (
          this.items.length > 0 &&
          !this.simulatedOffline &&
          this.browserOnline &&
          Date.now() >= this.nextRetryAt
        ) {
          void this.flushQueue();
        }
      }, 4000);
    }
  }

  private loadFromLocalStorage(): QueuedReadoutItem[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as QueuedReadoutItem[]) : [];
    } catch {
      return [];
    }
  }

  private persistAll(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items));
    } catch {
      // ignore quota
    }
    void this.saveToIndexedDb(this.items);
  }

  private async openIdb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return null;
    return new Promise((resolve) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  private async saveToIndexedDb(list: QueuedReadoutItem[]): Promise<void> {
    const db = await this.openIdb();
    if (!db) return;
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.clear();
      for (const item of list) {
        store.put(item);
      }
    } catch {
      // ignore
    }
  }

  private async reconcileWithIndexedDb(): Promise<void> {
    const db = await this.openIdb();
    if (!db) return;
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const idbItems = (req.result as QueuedReadoutItem[]) || [];
        if (idbItems.length > 0 && this.items.length === 0) {
          this.items = idbItems;
          this.emit();
          void this.flushQueue();
        }
      };
    } catch {
      // ignore
    }
  }

  public getSnapshot(): OfflineQueueSnapshot {
    return {
      pendingItems: [...this.items],
      simulatedOffline: this.simulatedOffline,
      browserOnline: this.browserOnline,
      flushing: this.flushing,
      lastError: this.lastError,
      totalSyncedSession: this.totalSyncedSession,
      lastSyncedAt: this.lastSyncedAt,
    };
  }

  public subscribe(cb: SnapshotListener): () => void {
    this.listeners.add(cb);
    cb(this.getSnapshot());
    return () => this.listeners.delete(cb);
  }

  public onItemSynced(cb: SyncedResultListener): () => void {
    this.syncedListeners.add(cb);
    return () => this.syncedListeners.delete(cb);
  }

  private emit(): void {
    const snap = this.getSnapshot();
    this.listeners.forEach((cb) => cb(snap));
  }

  private recordDeliverySuccess(): void {
    this.lastError = null;
    this.retryDelayMs = INITIAL_RETRY_DELAY_MS;
    this.nextRetryAt = 0;
  }

  private recordDeliveryFailure(error: unknown): void {
    this.lastError =
      error instanceof Error
        ? `Firestore kunde inte synka avläsningen: ${error.message}`
        : 'Firestore kunde inte synka avläsningen.';
    this.nextRetryAt = Date.now() + this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    this.emit();
  }

  public setSimulatedOffline(offline: boolean): void {
    this.simulatedOffline = offline;
    if (typeof window !== 'undefined') {
      localStorage.setItem(SIM_OFFLINE_KEY, offline ? 'true' : 'false');
    }
    this.emit();
    if (!offline) {
      void this.flushQueue();
    }
  }

  private async withDeliveryTimeout<T>(delivery: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        delivery,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error('Synkningen tog för lång tid. Kontrollera anslutningen och försök igen.')
              ),
            DELIVERY_TIMEOUT_MS
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Stores the SI-card readout in the durable browser queue FIRST before attempting
   * delivery to Firestore, guaranteeing zero lost readouts if 4G drops in the forest.
   */
  public async submitReadoutGuaranteed(
    readout: FullCardReadoutPayload,
    eventId?: string
  ): Promise<ReadoutDeliveryResult> {
    const clientReadoutId =
      readout.clientReadoutId ||
      `ro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const enriched: FullCardReadoutPayload = {
      ...readout,
      clientReadoutId,
    };

    const queueItem: QueuedReadoutItem = {
      id: clientReadoutId,
      kind: 'READOUT',
      createdAt: new Date().toISOString(),
      eventId,
      readoutPayload: enriched,
    };

    // 1. Write to local durable queue FIRST!
    this.items.push(queueItem);
    this.persistAll();
    this.emit();

    // 2. If offline or simulated forest-offline, keep safely queued!
    if (this.simulatedOffline || !this.browserOnline) {
      return { queuedOffline: true };
    }

    // 3. Try immediate delivery & flush
    const delivered = await this.deliverSingleItem(queueItem);
    if (delivered) {
      this.items = this.items.filter((x) => x.id !== queueItem.id);
      this.totalSyncedSession += 1;
      this.lastSyncedAt = new Date().toISOString();
      this.persistAll();
      this.emit();
      return delivered;
    }

    return { queuedOffline: true };
  }

  public async submitOnlinePunchGuaranteed(
    params: {
      siNumber: number;
      stationCode: number;
      punchTimeSec?: number;
      rawHex?: string;
      stationName?: string;
      stationFunction?: StationFunction;
      timeOffsetSec?: number;
    },
    eventId?: string
  ): Promise<{ queuedOffline: boolean }> {
    const clientPunchId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const queueItem: QueuedReadoutItem = {
      id: clientPunchId,
      kind: 'ONLINE_PUNCH',
      createdAt: new Date().toISOString(),
      eventId,
      onlinePunchPayload: {
        clientPunchId,
        ...params,
      },
    };

    this.items.push(queueItem);
    this.persistAll();
    this.emit();

    if (this.simulatedOffline || !this.browserOnline) {
      return { queuedOffline: true };
    }

    const delivered = await this.deliverSingleItem(queueItem);
    if (delivered) {
      this.items = this.items.filter((x) => x.id !== queueItem.id);
      this.totalSyncedSession += 1;
      this.lastSyncedAt = new Date().toISOString();
      this.persistAll();
      this.emit();
      return { queuedOffline: false };
    }

    return { queuedOffline: true };
  }

  private async deliverSingleItem(
    item: QueuedReadoutItem
  ): Promise<ReadoutDeliveryResult | null> {
    try {
      if (item.kind === 'READOUT' && item.readoutPayload) {
        const data = await this.withDeliveryTimeout(
          submitReadoutToFirestore(item.eventId, item.readoutPayload)
        );
        this.recordDeliverySuccess();
        return { queuedOffline: false, ...data };
      }

      if (item.kind === 'ONLINE_PUNCH' && item.onlinePunchPayload) {
        if (!item.eventId) throw new Error('Tävlingen för online-stämplingen saknas.');
        await this.withDeliveryTimeout(
          submitOnlinePunchToFirestore(item.eventId, item.onlinePunchPayload)
        );
        this.recordDeliverySuccess();
        return { queuedOffline: false };
      }

      this.lastError = 'Köposten saknar giltiga avläsningsdata.';
      this.emit();
      return null;
    } catch (error) {
      this.recordDeliveryFailure(error);
      return null;
    }
  }

  public async flushQueue(): Promise<number> {
    if (
      this.flushing ||
      this.simulatedOffline ||
      !this.browserOnline ||
      this.items.length === 0
    ) {
      return 0;
    }

    this.flushing = true;
    this.lastError = null;
    this.emit();

    let syncedNow = 0;
    try {
      const snapshotCopy = [...this.items];
      for (const item of snapshotCopy) {
        if (this.simulatedOffline || !this.browserOnline) break;
        const res = await this.deliverSingleItem(item);
        if (!res) break;

        this.items = this.items.filter((x) => x.id !== item.id);
        this.totalSyncedSession += 1;
        this.lastSyncedAt = new Date().toISOString();
        syncedNow += 1;
        this.persistAll();
        this.syncedListeners.forEach((cb) => cb(res));
      }
    } finally {
      this.flushing = false;
      this.emit();
    }

    return syncedNow;
  }

  public clearQueue(): void {
    this.items = [];
    this.lastError = null;
    this.retryDelayMs = INITIAL_RETRY_DELAY_MS;
    this.nextRetryAt = 0;
    this.persistAll();
    this.emit();
  }
}

export const offlineReadoutQueue = new OfflineReadoutQueueManager();
