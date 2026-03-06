import { AppConfig } from "../../config/env";
import { AppLogger } from "../logger";
import { withRetry } from "../retry";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface GlmResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const GLM_REQUEST_TIMEOUT_MS = 20_000;

class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
  }
}

function parseJsonContent<T>(content: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(content.slice(start, end + 1)) as T;
    }

    throw new Error("GLM response did not contain valid JSON.");
  }
}

export class GlmClient {
  constructor(
    private readonly config: AppConfig["glm"],
    private readonly logger: AppLogger,
  ) {}

  async completeJson<T>(
    messages: ChatMessage[],
    temperature = 0.4,
  ): Promise<T> {
    const response = await this.request({
      model: this.config.model,
      temperature,
      stream: false,
      response_format: {
        type: "json_object",
      },
      messages,
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("GLM returned an empty response.");
    }

    return parseJsonContent<T>(content);
  }

  private async request(payload: unknown): Promise<GlmResponse> {
    const endpoint = `${this.config.baseUrl}/chat/completions`;

    return withRetry(
      async () => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          signal: AbortSignal.timeout(GLM_REQUEST_TIMEOUT_MS),
          body: JSON.stringify(payload),
        });

        const body = await response.text();
        if (!response.ok) {
          throw new HttpError("GLM API request failed.", response.status, body);
        }

        return JSON.parse(body) as GlmResponse;
      },
      {
        attempts: 4,
        minDelayMs: 1_000,
        maxDelayMs: 10_000,
        shouldRetry: (error) => {
          if (isTimeoutError(error)) {
            return false;
          }

          if (error instanceof HttpError) {
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
            "Retrying GLM request",
          );
        },
      },
    );
  }
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "TimeoutError" || error.name === "AbortError";
}
