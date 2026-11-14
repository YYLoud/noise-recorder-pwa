import type { NoiseEvent, RecordingSession } from '../types.ts';

const DB_NAME = 'NoiseRecorderDB';
const DB_VERSION = 1;
const STORE_SESSIONS = 'sessions';
const STORE_EVENTS = 'events';

export class EvidenceStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
            const sessionStore = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
            sessionStore.createIndex('startTime', 'startTime', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_EVENTS)) {
            const eventStore = db.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
            eventStore.createIndex('sessionId', 'sessionId', { unique: false });
            eventStore.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('無法開啟 IndexedDB'));
      });
    }
    return this.dbPromise;
  }

  private runTx<T>(
    storeName: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return this.getDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, mode);
          const store = tx.objectStore(storeName);
          const req = fn(store);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error ?? new Error(`IndexedDB ${storeName} 操作失敗`));
        }),
    );
  }

  public async saveSession(session: RecordingSession): Promise<void> {
    await this.runTx(STORE_SESSIONS, 'readwrite', (store) => store.put(session));
  }

  public async getSessions(): Promise<RecordingSession[]> {
    const items = await this.runTx(STORE_SESSIONS, 'readonly', (store) => store.getAll());
    return (items as RecordingSession[]).sort((a, b) => b.startTime - a.startTime);
  }

  public async getSessionById(id: string): Promise<RecordingSession | undefined> {
    const result = await this.runTx(STORE_SESSIONS, 'readonly', (store) => store.get(id));
    return result as RecordingSession | undefined;
  }

  public async deleteSession(sessionId: string): Promise<void> {
    await this.runTx(STORE_SESSIONS, 'readwrite', (store) => store.delete(sessionId));
    const events = await this.getEventsBySession(sessionId);
    for (const evt of events) {
      await this.deleteEvent(evt.id);
    }
  }

  public async saveEvent(event: NoiseEvent): Promise<void> {
    await this.runTx(STORE_EVENTS, 'readwrite', (store) => store.put(event));
  }

  public async getAllEvents(): Promise<NoiseEvent[]> {
    const items = await this.runTx(STORE_EVENTS, 'readonly', (store) => store.getAll());
    return (items as NoiseEvent[]).sort((a, b) => b.timestamp - a.timestamp);
  }

  public async getEventsBySession(sessionId: string): Promise<NoiseEvent[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_EVENTS, 'readonly');
      const index = tx.objectStore(STORE_EVENTS).index('sessionId');
      const req = index.getAll(sessionId);
      req.onsuccess = () => {
        const list = (req.result as NoiseEvent[]).sort((a, b) => a.videoOffsetSec - b.videoOffsetSec);
        resolve(list);
      };
      req.onerror = () => reject(req.error ?? new Error('查詢場次事件失敗'));
    });
  }

  public async deleteEvent(eventId: string): Promise<void> {
    await this.runTx(STORE_EVENTS, 'readwrite', (store) => store.delete(eventId));
  }

  public async clearAll(): Promise<void> {
    const db = await this.getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_SESSIONS, STORE_EVENTS], 'readwrite');
      tx.objectStore(STORE_SESSIONS).clear();
      tx.objectStore(STORE_EVENTS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('清空資料庫失敗'));
    });
  }

  public async getStorageStats(): Promise<{ sessionCount: number; eventCount: number; totalBytes: number }> {
    const [sessions, events] = await Promise.all([this.getSessions(), this.getAllEvents()]);
    const totalBytes = sessions.reduce((acc, s) => acc + (s.fileSize || s.videoBlob?.size || 0), 0);
    return {
      sessionCount: sessions.length,
      eventCount: events.length,
      totalBytes,
    };
  }
}
