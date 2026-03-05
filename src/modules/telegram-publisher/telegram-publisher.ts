import { AppConfig } from "../../config/env";
import { AppLogger } from "../../services/logger";
import { withRetry } from "../../services/retry";

interface DeliverReelInput {
  videoUrl: string;
  caption: string;
  hashtags: string[];
  sourcePermalink?: string;
}

interface DeliverReelResult {
  chatId: string;
  videoMessageId: number;
  captionMessageId?: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramMessage {
  message_id: number;
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

export class TelegramPublisher {
  constructor(
    private readonly config: AppConfig["telegram"],
    private readonly logger: AppLogger,
  ) {}

  async deliverReel(input: DeliverReelInput): Promise<DeliverReelResult> {
    const chatId = this.resolveChatId();
    const caption = buildTelegramVideoCaption(input.caption, input.hashtags, input.sourcePermalink);
    const shortCaption = caption.slice(0, 1_000);

    const videoMessage = await this.post<TelegramMessage>("sendVideo", {
      chat_id: chatId,
      video: input.videoUrl,
      caption: shortCaption,
      disable_notification: String(this.config.deliveryDisableNotification),
      supports_streaming: "true",
    });

    let captionMessageId: number | undefined;
    if (caption.length > shortCaption.length) {
      const remainder = caption.slice(shortCaption.length).trim();
      if (remainder) {
        const textMessage = await this.post<TelegramMessage>("sendMessage", {
          chat_id: chatId,
          text: remainder,
          disable_notification: String(this.config.deliveryDisableNotification),
        });
        captionMessageId = textMessage.message_id;
      }
    }

    this.logger.info(
      {
        chatId,
        videoMessageId: videoMessage.message_id,
        captionMessageId,
      },
      "Delivered generated Reel to Telegram",
    );

    return {
      chatId,
      videoMessageId: videoMessage.message_id,
      captionMessageId,
    };
  }

  private resolveChatId(): string {
    return (this.config.deliveryChatId || this.config.channel).trim();
  }

  private async post<T>(method: string, payload: Record<string, string>): Promise<T> {
    return withRetry(
      async () => {
        const url = `https://api.telegram.org/bot${this.config.botToken}/${method}`;
        const body = new URLSearchParams(payload);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        });

        const raw = await response.text();
        if (!response.ok) {
          throw new TelegramApiError(`Telegram ${method} request failed.`, response.status, raw);
        }

        const parsed = JSON.parse(raw) as TelegramApiResponse<T>;
        if (!parsed.ok || !parsed.result) {
          throw new Error(`Telegram ${method} failed: ${parsed.description || raw}`);
        }

        return parsed.result;
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
              method,
              attempt,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
            },
            "Retrying Telegram delivery request",
          );
        },
      },
    );
  }
}

function buildTelegramVideoCaption(
  caption: string,
  hashtags: string[],
  sourcePermalink?: string,
): string {
  const parts: string[] = [];
  const normalizedCaption = caption.trim();
  if (normalizedCaption) {
    parts.push(normalizedCaption);
  }

  const hashtagLine = hashtags.filter(Boolean).join(" ").trim();
  if (hashtagLine) {
    parts.push(hashtagLine);
  }

  if (sourcePermalink) {
    parts.push(`Источник: ${sourcePermalink}`);
  }

  return parts.join("\n\n");
}
