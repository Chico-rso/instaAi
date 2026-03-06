import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AppConfig } from "../config/env";
import { AppLogger } from "./logger";
import { withRetry } from "./retry";

class PikaApiError extends Error {
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

export class PikaClient {
  constructor(
    private readonly config: AppConfig["pika"],
    private readonly logger: AppLogger,
  ) {}

  async generateShortVideo(prompt: string): Promise<{ videoUrl: string }> {
    const payload: Record<string, unknown> = {
      prompt,
      aspect_ratio: this.config.aspectRatio,
      duration: this.config.durationSec,
    };

    if (this.config.negativePrompt) {
      payload.negative_prompt = this.config.negativePrompt;
    }

    const submitted = await this.requestJson<Record<string, unknown>>(
      "POST",
      "",
      payload,
    );

    const immediateVideoUrl = extractVideoUrl(submitted);
    if (immediateVideoUrl) {
      return { videoUrl: immediateVideoUrl };
    }

    const requestId = extractRequestId(submitted);
    if (!requestId) {
      throw new Error(`Pika queue did not return request_id: ${JSON.stringify(submitted)}`);
    }

    const statusUrl = extractEndpointUrl(submitted, ["status_url", "statusUrl"]);
    const responseUrl = extractEndpointUrl(submitted, ["response_url", "responseUrl"]);

    const deadline = Date.now() + this.config.pollTimeoutMs;
    while (Date.now() < deadline) {
      const statusPayload = statusUrl
        ? await this.requestJsonUrl<Record<string, unknown>>("GET", statusUrl)
        : await this.requestJson<Record<string, unknown>>(
          "GET",
          `/requests/${encodeURIComponent(requestId)}/status`,
        );
      const status = readStatus(statusPayload);

      if (isCompletedStatus(status)) {
        break;
      }

      if (isFailedStatus(status)) {
        throw new Error(
          `Pika generation failed for ${requestId} with status ${status || "unknown"}.`,
        );
      }

      await sleep(this.config.pollIntervalMs);
    }

    const completed = responseUrl
      ? await this.requestJsonUrl<Record<string, unknown>>("GET", responseUrl)
      : await this.requestJson<Record<string, unknown>>(
        "GET",
        `/requests/${encodeURIComponent(requestId)}`,
      );
    const finalVideoUrl = extractVideoUrl(completed);
    if (!finalVideoUrl) {
      throw new Error(`Pika request ${requestId} completed without a video URL.`);
    }

    return { videoUrl: finalVideoUrl };
  }

  async downloadVideo(sourceUrl: string, targetPath: string): Promise<void> {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to download Pika video: ${response.status} ${body}`);
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
    return this.requestJsonUrl<T>(
      method,
      `${this.config.baseUrl}/${this.config.model}${path}`,
      body,
    );
  }

  private async requestJsonUrl<T>(
    method: "GET" | "POST",
    endpoint: string,
    body?: unknown,
  ): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetch(endpoint, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Key ${this.config.apiKey as string}`,
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const raw = await response.text();
        if (!response.ok) {
          throw new PikaApiError(
            `Pika API request failed with status ${response.status}: ${raw}`,
            response.status,
            raw,
          );
        }

        return JSON.parse(raw) as T;
      },
      {
        attempts: 4,
        minDelayMs: 1_500,
        maxDelayMs: 12_000,
        shouldRetry: (error) => {
          if (error instanceof PikaApiError) {
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
            "Retrying Pika API request",
          );
        },
      },
    );
  }
}

function extractEndpointUrl(
  payload: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      return value;
    }
  }

  return undefined;
}

function extractRequestId(payload: Record<string, unknown>): string | undefined {
  const directRequestId = payload.request_id;
  if (typeof directRequestId === "string") {
    return directRequestId;
  }

  const requestId = payload.requestId;
  if (typeof requestId === "string") {
    return requestId;
  }

  const data = payload.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const nestedRequestId = (data as Record<string, unknown>).request_id;
    if (typeof nestedRequestId === "string") {
      return nestedRequestId;
    }
  }

  return undefined;
}

function readStatus(payload: Record<string, unknown>): string {
  const status = payload.status;
  if (typeof status === "string") {
    return status.toLowerCase();
  }

  const data = payload.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const nestedStatus = (data as Record<string, unknown>).status;
    if (typeof nestedStatus === "string") {
      return nestedStatus.toLowerCase();
    }
  }

  return "";
}

function isCompletedStatus(status: string): boolean {
  return [
    "completed",
    "success",
    "succeeded",
    "done",
    "completed_with_warnings",
  ].includes(status);
}

function isFailedStatus(status: string): boolean {
  return ["failed", "error", "canceled", "cancelled"].includes(status);
}

function extractVideoUrl(payload: Record<string, unknown>): string | undefined {
  const urls: string[] = [];
  collectUrls(payload, urls);
  return urls[0];
}

function collectUrls(value: unknown, urls: string[]): void {
  if (!value || urls.length > 0) {
    return;
  }

  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    if (/\.(mp4|mov|webm)(\?|$)/i.test(value) || /video/i.test(value)) {
      urls.push(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrls(item, urls);
      if (urls.length > 0) {
        return;
      }
    }
    return;
  }

  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectUrls(item, urls);
      if (urls.length > 0) {
        return;
      }
    }
  }
}
