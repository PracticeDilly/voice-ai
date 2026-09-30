import type { OfficeContext } from "./callSession.js";

interface CacheEntry {
  context: OfficeContext;
  expiresAt: number;
  lastAccessAt: number;
}

export interface OfficeContextCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * Process-local cache for immutable-ish office configuration.
 * In-flight loads are shared so concurrent calls for the same office do not
 * stampede Spring Boot.
 */
export class OfficeContextCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<OfficeContext>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: OfficeContextCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 1_000;
    this.now = options.now ?? Date.now;

    if (this.ttlMs <= 0 || this.maxEntries <= 0) {
      throw new Error("Office context cache ttlMs and maxEntries must be positive");
    }
  }

  async getOrLoad(officeCode: string, loader: () => Promise<OfficeContext>): Promise<OfficeContext> {
    const key = officeCode.trim();
    if (!key) throw new Error("officeCode is required for office context cache");

    const now = this.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) {
      cached.lastAccessAt = now;
      return cached.context;
    }
    if (cached) this.entries.delete(key);

    const existingLoad = this.inFlight.get(key);
    if (existingLoad) return existingLoad;

    const load = loader()
      .then((context) => {
        const storedAt = this.now();
        this.entries.set(key, {
          context,
          expiresAt: storedAt + this.ttlMs,
          lastAccessAt: storedAt
        });
        this.evictLeastRecentlyUsed();
        return context;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, load);
    return load;
  }

  invalidate(officeCode: string): void {
    this.entries.delete(officeCode.trim());
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private evictLeastRecentlyUsed(): void {
    while (this.entries.size > this.maxEntries) {
      const leastRecentlyUsed = [...this.entries.entries()]
        .reduce((oldest, current) => current[1].lastAccessAt < oldest[1].lastAccessAt ? current : oldest);
      this.entries.delete(leastRecentlyUsed[0]);
    }
  }
}
