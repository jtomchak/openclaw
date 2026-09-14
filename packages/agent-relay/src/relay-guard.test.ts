/// <reference path="./cloudflare-runtime.d.ts" />

import { describe, expect, it } from "vitest";
import { AgentRelayGuard } from "./relay-guard.js";

class MemoryStorage implements DurableObjectStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.values.set(key, structuredClone(value));
  }
  async transaction<T>(callback: (transaction: DurableObjectStorageTransaction) => Promise<T>) {
    return await callback(this);
  }
}

function consume(guard: AgentRelayGuard, input: Record<string, unknown>) {
  return guard.fetch(
    new Request("https://guard/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

describe("AgentRelayGuard", () => {
  it("atomically rejects replay and bounds attempts within a window", async () => {
    const guard = new AgentRelayGuard({ storage: new MemoryStorage() });
    const base = { limit: 2, nowMs: 1_000, replayExpiresAtMs: 61_000, windowMs: 60_000 };
    expect((await consume(guard, { ...base, replayKey: "nonce-a" })).status).toBe(200);
    expect((await consume(guard, { ...base, replayKey: "nonce-a" })).status).toBe(409);
    expect((await consume(guard, { ...base, replayKey: "nonce-b" })).status).toBe(429);
  });
});
