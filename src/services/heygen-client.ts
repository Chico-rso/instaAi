import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AppConfig } from "../config/env";
import { AppLogger } from "./logger";
import { withRetry } from "./retry";

interface HeygenGenerateResponse {
  data?: {
    video_id?: string;
  };
  error?: {
    message?: string;
    code?: string | number;
  };
}

interface HeygenStatusResponse {
  data?: {
    status?: string;
    video_url?: string;
    error?: string | { message?: string };
  };
  error?: {
    message?: string;
    code?: string | number;
  };
}

class HeygenApiError extends Error {
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

export class HeygenClient {
  constructor(
    private readonly config: AppConfig["heygen"],
    private readonly logger: AppLogger,
  ) {}

  async generateTalkingAvatarVideo(scriptText: string): Promise<string> {
    const payload = {
      video_inputs: [
        {
          character: {
            type: "avatar",
            avatar_id: this.config.avatarId,
            avatar_style: this.config.avatarStyle,
          },
          voice: {
            type: "text",
            input_text: scriptText,
            voice_id: this.config.voiceId,
          },
          background: {
            type: "color",
            color: {
              value: this.config.backgroundColor,
            },
          },
        },
      ],
      dimension: {
        width: this.config.width,
        height: this.config.height,
      },
    };

    const response = await this.requestJson<HeygenGenerateResponse>("POST", "/v2/video/generate", payload);
    const videoId = response.data?.video_id;
    if (!videoId) {
      throw new Error(`HeyGen did not return video_id: ${JSON.stringify(response)}`);
    }

    this.logger.info({ videoId }, "Created HeyGen video job");
    return videoId;
  }

  async waitForCompletion(videoId: string): Promise<{ videoUrl: string }> {
    const deadline = Date.now() + this.config.pollTimeoutMs;

    while (Date.now() < deadline) {
      const statusResponse = await this.requestJson<HeygenStatusResponse>(
        "GET",
        `/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
      );

      const status = (statusResponse.data?.status || "").toLowerCase();
      if (isCompletedStatus(status)) {
        const videoUrl = statusResponse.data?.video_url;
        if (!videoUrl) {
          throw new Error(`HeyGen status is completed, but no video_url returned for ${videoId}.`);
        }

        return { videoUrl };
      }

      if (isFailedStatus(status)) {
        const errorDetails = extractHeygenStatusError(statusResponse.data?.error);
        throw new Error(
          `HeyGen video generation failed for ${videoId} with status ${status || "unknown"}${errorDetails ? `: ${errorDetails}` : ""}`,
        );
      }

      await sleep(this.config.pollIntervalMs);
    }

    throw new Error(`Timed out while waiting for HeyGen video completion (${videoId}).`);
  }

  async downloadVideo(sourceUrl: string, targetPath: string): Promise<void> {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to download HeyGen video: ${response.status} ${body}`);
    }

    const bytes = await response.arrayBuffer();
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, Buffer.from(bytes));
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetch(`${this.config.baseUrl}${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": this.config.apiKey as string,
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const raw = await response.text();
        if (!response.ok) {
          throw new HeygenApiError(
            `HeyGen API request failed with status ${response.status}: ${raw}`,
            response.status,
            raw,
          );
        }

        const parsed = JSON.parse(raw) as T;
        return parsed;
      },
      {
        attempts: 4,
        minDelayMs: 1_500,
        maxDelayMs: 12_000,
        shouldRetry: (error) => {
          if (error instanceof HeygenApiError) {
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
            "Retrying HeyGen API request",
          );
        },
      },
    );
  }
}

function isCompletedStatus(status: string): boolean {
  return status === "completed" || status === "success" || status === "done";
}

function isFailedStatus(status: string): boolean {
  return status === "failed" || status === "error" || status === "rejected" || status === "canceled";
}

function extractHeygenStatusError(errorValue?: string | { message?: string }): string | undefined {
  if (!errorValue) {
    return undefined;
  }

  if (typeof errorValue === "string") {
    return errorValue;
  }

  return errorValue.message;
}
