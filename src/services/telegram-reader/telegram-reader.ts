import { AppConfig } from "../../config/env";
import { RawTelegramPost } from "../../types";
import { AppLogger } from "../logger";
import { withRetry } from "../retry";
import { JobStateStore } from "../job-state-store";

interface TelegramUpdate {
  update_id: number;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: {
    id: number;
    username?: string;
    title?: string;
  };
}

interface TelegramApiResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
  }
}

export class TelegramReader {
  constructor(
    private readonly config: AppConfig["telegram"],
    private readonly stateStore: JobStateStore,
    private readonly logger: AppLogger,
  ) {}

  async getLatestPost(): Promise<RawTelegramPost | undefined> {
    if (this.config.mode === "polling") {
      await this.pollUpdates();
    }

    return this.stateStore.getLatestTelegramPost();
  }

  async captureWebhookUpdate(
    payload: unknown,
    secretHeader?: string,
  ): Promise<RawTelegramPost | undefined> {
    if (this.config.webhookSecret && secretHeader !== this.config.webhookSecret) {
      throw new Error("Telegram webhook secret mismatch.");
    }

    const update = payload as TelegramUpdate;
    const post = this.extractPost(update);
    if (post) {
      await this.stateStore.setLatestTelegramPost(post);
      this.logger.info({ postId: post.id }, "Stored Telegram post from webhook");
    }

    return post;
  }

  private async pollUpdates(): Promise<void> {
    const cursor = await this.stateStore.getTelegramCursor();
    const params = new URLSearchParams();
    params.set("timeout", "1");
    params.set("allowed_updates", JSON.stringify(["channel_post", "edited_channel_post"]));

    if (cursor) {
      params.set("offset", String(cursor));
    }

    const response = await this.requestTelegram<TelegramApiResponse>(
      `getUpdates?${params.toString()}`,
    );

    if (!response.ok) {
      throw new Error("Telegram API returned ok=false.");
    }

    const updates = response.result.sort((left, right) => left.update_id - right.update_id);
    if (!updates.length) {
      return;
    }

    let nextCursor = cursor ?? 0;
    for (const update of updates) {
      nextCursor = Math.max(nextCursor, update.update_id + 1);
      const post = this.extractPost(update);
      if (post) {
        await this.stateStore.setLatestTelegramPost(post);
      }
    }

    await this.stateStore.setTelegramCursor(nextCursor);
  }

  private extractPost(update: TelegramUpdate): RawTelegramPost | undefined {
    const message = update.channel_post ?? update.edited_channel_post;
    if (!message) {
      return undefined;
    }

    if (!this.matchesChannel(message.chat)) {
      return undefined;
    }

    const text = message.text?.trim() || message.caption?.trim();
    if (!text) {
      return undefined;
    }

    const channel = message.chat.username || message.chat.title || String(message.chat.id);
    return {
      id: `${message.chat.id}:${message.message_id}`,
      messageId: message.message_id,
      channel,
      text,
      date: new Date(message.date * 1_000).toISOString(),
      permalink: message.chat.username
        ? `https://t.me/${message.chat.username}/${message.message_id}`
        : undefined,
    };
  }

  private matchesChannel(chat: TelegramMessage["chat"]): boolean {
    const configured = this.config.channel.replace(/^@/, "").trim().toLowerCase();
    const username = chat.username?.replace(/^@/, "").trim().toLowerCase();
    const numericId = String(chat.id);

    return configured === numericId || configured === username;
  }

  private async requestTelegram<T>(path: string): Promise<T> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/${path}`;

    return withRetry(
      async () => {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        });

        const body = await response.text();
        if (!response.ok) {
          throw new TelegramApiError("Telegram API request failed.", response.status, body);
        }

        return JSON.parse(body) as T;
      },
      {
        attempts: 4,
        minDelayMs: 1_000,
        maxDelayMs: 8_000,
        shouldRetry: (error) => {
          if (error instanceof TelegramApiError) {
            return error.status === 429 || error.status >= 500;
          }

          return true;
        },
        onRetry: (error, attempt, delayMs) => {
          this.logger.warn(
            {
              attempt,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
            },
            "Retrying Telegram request",
          );
        },
      },
    );
  }
}
