interface DurableObjectId {}

interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  get(id: DurableObjectId): DurableObjectStub;
  idFromName(name: string): DurableObjectId;
}

interface DurableObjectStorageTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface DurableObjectStorage extends DurableObjectStorageTransaction {
  transaction<T>(
    callback: (transaction: DurableObjectStorageTransaction) => Promise<T>,
  ): Promise<T>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

interface ExportedHandler<Env> {
  fetch(request: Request, env: Env): Promise<Response> | Response;
}

interface Response {
  readonly webSocket?: WebSocket | null;
}

interface WebSocket {
  accept(): void;
}
