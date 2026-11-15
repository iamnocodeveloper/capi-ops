import { Bot } from 'grammy';
import { telegramCfg } from './config.js';
import type { Severity } from './types.js';

export interface TelegramStatus {
  enabled: boolean;
  polling: boolean;
  pollingStopped: boolean;
  lastPollError: string | null;
  lastPollErrorAt: number | null;
  lastSendOkAt: number | null;
  lastSendError: string | null;
  lastSendErrorAt: number | null;
  consecutiveFailures: number;
}

export class TelegramNotifier {
  readonly bot: Bot | null;
  private lastSent = new Map<string, number>();
  private readonly startedAt = Date.now();
  private pollingSince: number | null = null;
  private pollingStopped = false;
  private lastPollError: string | null = null;
  private lastPollErrorAt: number | null = null;
  private lastSendOkAt: number | null = null;
  private lastSendError: string | null = null;
  private lastSendErrorAt: number | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly log: (line: string) => void) {
    this.bot = telegramCfg.enabled ? new Bot(telegramCfg.token) : null;
    if (this.bot) {
      this.bot.catch((err) => {
        this.log(`telegram error: ${err.message}`);
      });
    }
  }

  get enabled(): boolean {
    return this.bot !== null;
  }

  /** El polling arrancó (callback `onStart` de grammY). */
  markPollingStarted(): void {
    this.pollingSince = Date.now();
    this.pollingStopped = false;
    this.lastPollError = null;
    this.lastPollErrorAt = null;
  }

  /** El polling se detuvo por un error fatal (`bot.start` rechazó). */
  markPollingError(message: string): void {
    this.pollingStopped = true;
    this.lastPollError = message;
    this.lastPollErrorAt = Date.now();
    this.log(`telegram polling detenido: ${message}`);
  }

  status(): TelegramStatus {
    return {
      enabled: this.bot !== null,
      polling: this.pollingSince !== null && !this.pollingStopped,
      pollingStopped: this.pollingStopped,
      lastPollError: this.lastPollError,
      lastPollErrorAt: this.lastPollErrorAt,
      lastSendOkAt: this.lastSendOkAt,
      lastSendError: this.lastSendError,
      lastSendErrorAt: this.lastSendErrorAt,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * `true` si Telegram no está configurado (modo consola) o está entregando.
   * Mientras el polling no haya arrancado no se alerta durante `startGraceMs`: el primer
   * ciclo del watcher corre antes de `bot.start()` y puede tardar varios minutos.
   */
  healthy(startGraceMs = 300_000): boolean {
    if (!this.bot) return true;
    if (this.pollingStopped) return false;
    if (this.pollingSince === null) return Date.now() - this.startedAt < startGraceMs;
    if (this.consecutiveFailures >= 3) return false;
    return true;
  }

  describeProblem(): string {
    if (!this.bot) return 'Telegram deshabilitado (modo consola).';
    if (this.pollingStopped) return `Polling detenido: ${this.lastPollError ?? 'error desconocido'}`;
    if (this.pollingSince === null) return 'El bot todavía no inició el polling.';
    if (this.consecutiveFailures >= 3) {
      return `${this.consecutiveFailures} envíos fallidos seguidos. Último: ${this.lastSendError ?? 'desconocido'}`;
    }
    return 'ok';
  }

  async send(chatId: number | string, text: string): Promise<void> {
    if (!this.bot) {
      this.log(`[telegram off] ${stripTags(text)}`);
      return;
    }
    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      this.lastSendOkAt = Date.now();
      this.lastSendError = null;
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      this.lastSendError = (err as Error).message;
      this.lastSendErrorAt = Date.now();
      this.log(`no se pudo enviar a ${chatId}: ${this.lastSendError}`);
    }
  }

  /** Manda a todos los chats autorizados (y al admin si está configurado). */
  async broadcast(text: string, severity: Severity = 'info'): Promise<void> {
    const targets = new Set<number>(telegramCfg.allowedChats);
    if (telegramCfg.adminChat) targets.add(telegramCfg.adminChat);
    if (targets.size === 0) {
      this.log(`[sin chats configurados] ${stripTags(text)}`);
      return;
    }
    for (const chatId of targets) {
      const key = `${chatId}:${severity}`;
      const last = this.lastSent.get(key) ?? 0;
      if (Date.now() - last < 800) {
        await new Promise((r) => setTimeout(r, 800 - (Date.now() - last)));
      }
      this.lastSent.set(key, Date.now());
      await this.send(chatId, text);
    }
  }
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}
