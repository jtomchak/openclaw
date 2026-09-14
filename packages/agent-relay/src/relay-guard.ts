/// <reference path="./cloudflare-runtime.d.ts" />

interface GuardRecord {
  rateCount: number;
  rateWindowStartedAtMs: number;
  replays: Record<string, number>;
}

interface GuardRequest {
  limit: number;
  nowMs: number;
  replayExpiresAtMs: number;
  replayKey: string;
  windowMs: number;
}

const STATE_KEY = "guard";
const MAX_REPLAY_KEYS = 256;

export class AgentRelayGuard {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
    const input = (await request.json()) as GuardRequest;
    if (
      !input ||
      !Number.isSafeInteger(input.nowMs) ||
      !Number.isSafeInteger(input.replayExpiresAtMs) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      !Number.isSafeInteger(input.windowMs) ||
      input.windowMs < 1 ||
      typeof input.replayKey !== "string" ||
      input.replayKey.length < 1 ||
      input.replayKey.length > 256
    ) {
      return Response.json({ error: "invalid" }, { status: 400 });
    }
    return this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<GuardRecord>(STATE_KEY);
      const record: GuardRecord = stored ?? {
        rateCount: 0,
        rateWindowStartedAtMs: input.nowMs,
        replays: {},
      };
      for (const [key, expiresAtMs] of Object.entries(record.replays)) {
        if (expiresAtMs <= input.nowMs) delete record.replays[key];
      }
      if (record.rateWindowStartedAtMs + input.windowMs <= input.nowMs) {
        record.rateCount = 0;
        record.rateWindowStartedAtMs = input.nowMs;
      }
      if (record.rateCount >= input.limit)
        return Response.json({ error: "rate_limited" }, { status: 429 });
      record.rateCount += 1;
      if (record.replays[input.replayKey] !== undefined) {
        await transaction.put(STATE_KEY, record);
        return Response.json({ error: "replayed" }, { status: 409 });
      }
      if (Object.keys(record.replays).length >= MAX_REPLAY_KEYS) {
        await transaction.put(STATE_KEY, record);
        return Response.json({ error: "capacity" }, { status: 429 });
      }
      record.replays[input.replayKey] = input.replayExpiresAtMs;
      await transaction.put(STATE_KEY, record);
      return Response.json({ ok: true });
    });
  }
}

export async function admitRelayRequest(params: {
  env: { AGENT_RELAY_GUARD: DurableObjectNamespace };
  ip: string;
  limit: number;
  nowMs: number;
  replayExpiresAtMs: number;
  replayKey: string;
  thumbprint: string;
  windowMs?: number;
}): Promise<void> {
  const input: GuardRequest = {
    limit: params.limit,
    nowMs: params.nowMs,
    replayExpiresAtMs: params.replayExpiresAtMs,
    replayKey: params.replayKey,
    windowMs: params.windowMs ?? 60_000,
  };
  for (const partition of [`ip:${params.ip}`, `device:${params.thumbprint}`]) {
    const id = params.env.AGENT_RELAY_GUARD.idFromName(partition);
    const response = await params.env.AGENT_RELAY_GUARD.get(id).fetch("https://guard/consume", {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new RelayAdmissionError(response.status);
  }
}

export class RelayAdmissionError extends Error {
  constructor(readonly status: number) {
    super(status === 409 ? "replayed request" : "rate limited");
  }
}
