import assert from "node:assert/strict";
import test from "node:test";
import { OfficeContextCache } from "../../src/calls/officeContextCache.js";

const context = (officeCode: string) => ({ officeCode, timezone: "America/Los_Angeles" });

test("reuses an office context until its TTL expires", async () => {
  let now = 1_000;
  let loads = 0;
  const cache = new OfficeContextCache({ ttlMs: 100, now: () => now });
  const loader = async () => {
    loads += 1;
    return context("OFFICE-1");
  };

  await cache.getOrLoad("OFFICE-1", loader);
  await cache.getOrLoad("OFFICE-1", loader);
  assert.equal(loads, 1);
  now += 100;
  await cache.getOrLoad("OFFICE-1", loader);
  assert.equal(loads, 2);
});

test("shares one in-flight load across concurrent calls", async () => {
  let loads = 0;
  let release!: (value: ReturnType<typeof context>) => void;
  const pending = new Promise<ReturnType<typeof context>>((resolve) => {
    release = resolve;
  });
  const cache = new OfficeContextCache();
  const loader = async () => {
    loads += 1;
    return pending;
  };

  const first = cache.getOrLoad("OFFICE-1", loader);
  const second = cache.getOrLoad("OFFICE-1", loader);
  assert.equal(loads, 1);
  release(context("OFFICE-1"));
  await Promise.all([first, second]);
});

test("does not cache failed loads and evicts least recently used offices", async () => {
  let loads = 0;
  const cache = new OfficeContextCache({ maxEntries: 2 });
  await assert.rejects(cache.getOrLoad("FAIL", async () => {
    loads += 1;
    throw new Error("backend unavailable");
  }));
  await assert.rejects(cache.getOrLoad("FAIL", async () => {
    loads += 1;
    throw new Error("backend unavailable");
  }));
  assert.equal(loads, 2);

  await cache.getOrLoad("A", async () => context("A"));
  await cache.getOrLoad("B", async () => context("B"));
  await cache.getOrLoad("A", async () => context("A"));
  await cache.getOrLoad("C", async () => context("C"));
  assert.equal(cache.size, 2);
  await cache.getOrLoad("B", async () => context("B"));
  assert.equal(cache.size, 2);
});
