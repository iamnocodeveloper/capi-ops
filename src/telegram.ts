import { Bot } from 'grammy';
import { telegramCfg } from './config.js';
import type { Severity } from './types.js';

export class TelegramNotifier {
  readonly bot: Bot | null;
  private lastSent = new Map<string, number>();

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
    } catch (err) {
      this.log(`no se pudo enviar a ${chatId}: ${(err as Error).message}`);
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
