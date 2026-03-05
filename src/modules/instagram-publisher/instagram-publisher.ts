import { AppConfig } from "../../config/env";
import { AppLogger } from "../../services/logger";
import { withRetry } from "../../services/retry";
import { InstagramAuthStore } from "../../services/instagram-auth-store";

interface PublishReelInput {
  videoUrl: string;
  caption: string;
  coverUrl?: string;
}

interface PublishReelResult {
  containerId: string;
  mediaId: string;
}

interface ContainerStatusResponse {
  id?: string;
  status_code?: string;
  status?: string;
  error_message?: string;
}

class InstagramApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export class InstagramPublisher {
  constructor(
    private readonly config: AppConfig["instagram"],
    private readonly logger: AppLogger,
    private readonly authStore?: InstagramAuthStore,
  ) {}

  async publishReel(input: PublishReelInput): Promise<PublishReelResult> {
    const credentials = await this.getCredentials();
    if (!credentials) {
      throw new Error("Instagram publishing is not configured.");
    }

    const mediaResponse = await this.postForm<{ id: string }>(
      `/${credentials.userId}/media`,
      {
        media_type: "REELS",
        video_url: input.videoUrl,
        caption: input.caption,
        share_to_feed: String(this.config.shareToFeed),
        ...(input.coverUrl ? { cover_url: input.coverUrl } : {}),
      },
      credentials.accessToken,
    );

    const containerId = mediaResponse.id;
    this.logger.info({ containerId, videoUrl: input.videoUrl }, "Created Instagram media container");
    await this.waitForContainer(containerId);

    const publishResponse = await this.postForm<{ id: string }>(
      `/${credentials.userId}/media_publish`,
      {
        creation_id: containerId,
      },
      credentials.accessToken,
    );

    this.logger.info(
      {
        containerId,
        mediaId: publishResponse.id,
      },
      "Published Instagram Reel",
    );

    return {
      containerId,
      mediaId: publishResponse.id,
    };
  }

  private async waitForContainer(containerId: string): Promise<void> {
    const credentials = await this.getCredentials();
    if (!credentials) {
      throw new Error("Instagram publishing credentials are not available.");
    }

    const deadline = Date.now() + this.config.pollTimeoutMs;

    while (Date.now() < deadline) {
      const status = await this.get<ContainerStatusResponse>(
        `/${containerId}`,
        {
          fields: "id,status_code,status,error_message",
        },
        credentials.accessToken,
      );

      const statusCode = String(status.status_code || status.status || "").toUpperCase();
      if (statusCode === "FINISHED" || statusCode === "PUBLISHED") {
        return;
      }

      if (statusCode === "ERROR" || statusCode === "EXPIRED") {
        this.logger.error(
          {
            containerId,
            statusCode,
            status,
          },
          "Instagram media container failed",
        );
        throw new Error(
          `Instagram media container failed with status ${statusCode}${status.error_message ? `: ${status.error_message}` : "."}`,
        );
      }

      await sleep(this.config.pollIntervalMs);
    }

    throw new Error("Timed out while waiting for Instagram media container.");
  }

  private async postForm<T>(
    path: string,
    payload: Record<string, string>,
    accessToken: string,
  ): Promise<T> {
    return withRetry(
      async () => {
        const body = new URLSearchParams({
          ...payload,
          access_token: accessToken,
        });

        const response = await fetch(this.buildUrl(path), {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        });

        const raw = await response.text();
        if (!response.ok) {
          throw new InstagramApiError(
            `Instagram Graph API POST failed: ${formatInstagramApiError(raw)}`,
            response.status,
            raw,
          );
        }

        return JSON.parse(raw) as T;
      },
      {
        attempts: 4,
        minDelayMs: 1_500,
        maxDelayMs: 10_000,
        shouldRetry: (error) => {
          if (error instanceof InstagramApiError) {
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
            "Retrying Instagram POST request",
          );
        },
      },
    );
  }

  private async get<T>(
    path: string,
    payload: Record<string, string>,
    accessToken: string,
  ): Promise<T> {
    return withRetry(
      async () => {
        const query = new URLSearchParams({
          ...payload,
          access_token: accessToken,
        });
        const response = await fetch(`${this.buildUrl(path)}?${query.toString()}`);
        const raw = await response.text();
        if (!response.ok) {
          throw new InstagramApiError(
            `Instagram Graph API GET failed: ${formatInstagramApiError(raw)}`,
            response.status,
            raw,
          );
        }

        return JSON.parse(raw) as T;
      },
      {
        attempts: 4,
        minDelayMs: 1_500,
        maxDelayMs: 10_000,
        shouldRetry: (error) => {
          if (error instanceof InstagramApiError) {
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
            "Retrying Instagram GET request",
          );
        },
      },
    );
  }

  private buildUrl(path: string): string {
    return `${this.config.graphBaseUrl}/${this.config.apiVersion}${path}`;
  }

  private async getCredentials(): Promise<{ accessToken: string; userId: string } | undefined> {
    if (this.config.accessToken && this.config.userId) {
      return {
        accessToken: this.config.accessToken,
        userId: this.config.userId,
      };
    }

    const session = await this.authStore?.getSession();
    if (!session?.accessToken || !session.user?.id) {
      return undefined;
    }

    return {
      accessToken: session.accessToken,
      userId: session.user.id,
    };
  }
}

function formatInstagramApiError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; type?: string; code?: number } };
    const message = parsed.error?.message;
    const type = parsed.error?.type;
    const code = parsed.error?.code;
    if (message) {
      const details = [type, typeof code === "number" ? `code=${code}` : undefined].filter(Boolean).join(", ");
      return details ? `${message} (${details})` : message;
    }
  } catch {
    // Keep original raw body fallback.
  }

  return raw;
}
