import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, type ConnectConfig } from 'ssh2';
import { env } from './config.js';
import type { ServerCfg } from './types.js';

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  hostKey?: string;
}

export function sshEnabled(): boolean {
  return env.DIAG_SSH;
}

/** Devuelve el target SSH del servidor o null si no está configurado. */
export function sshTargetFor(server: ServerCfg): SshTarget | null {
  const cfg = server.ssh;
  if (!cfg) return null;
  const password = cfg.passwordEnv ? process.env[cfg.passwordEnv]?.trim() : undefined;
  let privateKey: string | undefined;
  if (cfg.keyPath) {
    try {
      privateKey = readFileSync(cfg.keyPath, 'utf8');
    } catch {
      return null;
    }
  }
  if (!password && !privateKey) return null;
  return {
    host: cfg.host ?? server.ip,
    port: cfg.port ?? 22,
    username: cfg.user ?? 'root',
    ...(password ? { password } : {}),
    ...(privateKey ? { privateKey } : {}),
    ...(cfg.hostKey ? { hostKey: cfg.hostKey } : {}),
  };
}

export function hasSsh(server: ServerCfg): boolean {
  return sshEnabled() && sshTargetFor(server) !== null;
}

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export interface SshRunOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Ejecuta un comando de solo lectura por SSH. El comando lo construye siempre
 * `diagnostics.ts` con valores validados; nunca llega texto libre del usuario.
 */
export function runSsh(server: ServerCfg, command: string, options: SshRunOptions = {}): Promise<string> {
  const target = sshTargetFor(server);
  if (!target || !sshEnabled()) {
    return Promise.reject(new Error(`SSH no configurado para ${server.alias}`));
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 262_144;

  return new Promise<string>((resolve, reject) => {
    const client = new Client();
    let finished = false;
    let out = '';
    let err = '';

    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        client.end();
      } catch {
        /* noop */
      }
      if (error) reject(error);
      else resolve(out);
    };

    const timer = setTimeout(() => finish(new Error(`timeout SSH (${timeoutMs} ms)`)), timeoutMs);

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: timeoutMs,
      keepaliveInterval: 0,
      ...(target.password ? { password: target.password } : {}),
      ...(target.privateKey ? { privateKey: target.privateKey } : {}),
      ...(target.hostKey
        ? {
            hostVerifier: (key: Buffer) => fingerprint(key) === target.hostKey,
          }
        : {}),
    };

    client.on('ready', () => {
      client.exec(command, (error, stream) => {
        if (error) {
          finish(error);
          return;
        }
        stream.on('data', (chunk: Buffer) => {
          if (out.length < maxBytes) out += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          if (err.length < 8_192) err += chunk.toString('utf8');
        });
        stream.on('close', (code: number | null) => {
          if (code !== null && code !== 0 && !out.trim()) {
            finish(new Error(`SSH exit ${code}: ${err.trim().slice(0, 200) || 'sin detalle'}`));
            return;
          }
          finish();
        });
      });
    });

    client.on('error', (error) => finish(error));
    client.connect(config);
  });
}
