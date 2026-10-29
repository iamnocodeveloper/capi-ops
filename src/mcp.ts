import type { ServerCfg } from './types.js';
import { tokenOf } from './config.js';

export class McpError extends Error {
  constructor(
    message: string,
    readonly server: string,
    readonly tool?: string,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

const INIT_PARAMS = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'capi-ops', version: '0.1.0' },
};

/** Cliente mínimo de MCP por Streamable HTTP (JSON-RPC) contra un Coolify. */
export class McpClient {
  private id = 1;
  private ready: Promise<void> | null = null;

  constructor(private readonly cfg: ServerCfg) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${tokenOf(this.cfg)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
  }

  private async post(body: unknown, timeoutMs = 25_000): Promise<JsonRpcResponse> {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new McpError(`HTTP ${res.status} en ${this.cfg.url}: ${text.slice(0, 200)}`, this.cfg.alias);
    }
    return parseRpcBody(text) as JsonRpcResponse;
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const res = await this.post({
          jsonrpc: '2.0',
          id: this.id++,
          method: 'initialize',
          params: INIT_PARAMS,
        });
        if (res.error) throw new McpError(res.error.message, this.cfg.alias, 'initialize');
      })();
      // si falla, permitir reintento en la próxima llamada
      this.ready.catch(() => {
        this.ready = null;
      });
    }
    return this.ready;
  }

  /** Ejecuta una herramienta y devuelve el JSON decodificado de la respuesta. */
  async tool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ensureReady();
    const res = await this.post({
      jsonrpc: '2.0',
      id: this.id++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (res.error) throw new McpError(res.error.message, this.cfg.alias, name);
    const result = res.result;
    if (!result) throw new McpError('respuesta vacía', this.cfg.alias, name);
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');
    if (result.isError) {
      throw new McpError(text || 'error desconocido', this.cfg.alias, name);
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** Igual que tool() pero no tira: devuelve null si falla (para el watcher). */
  async tryTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T | null> {
    try {
      return await this.tool<T>(name, args);
    } catch {
      return null;
    }
  }
}

function parseRpcBody(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const dataLines = trimmed
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    const last = dataLines[dataLines.length - 1];
    if (!last) throw new Error('respuesta SSE sin datos');
    return JSON.parse(last);
  }
  return JSON.parse(trimmed);
}

const registry = new Map<string, McpClient>();

export function clientFor(server: ServerCfg): McpClient {
  const existing = registry.get(server.alias);
  if (existing) return existing;
  const client = new McpClient(server);
  registry.set(server.alias, client);
  return client;
}
