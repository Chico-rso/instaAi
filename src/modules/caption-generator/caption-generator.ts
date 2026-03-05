import { CaptionPayload, RawTelegramPost, ReelScript, StructuredTelegramContent } from "../../types";
import { normalizeHashtag, truncate } from "../../utils/strings";
import { GlmClient } from "../../services/ai-client/glm-client";
import { AppLogger } from "../../services/logger";

interface CaptionResponse {
  caption?: string;
  hashtags?: string[];
  firstComment?: string;
}

export class CaptionGenerator {
  constructor(
    private readonly glmClient: GlmClient,
    private readonly logger: AppLogger,
  ) {}

  async generate(
    post: RawTelegramPost,
    structuredContent: StructuredTelegramContent,
    reelScript: ReelScript,
  ): Promise<CaptionPayload> {
    const fallback = this.fallbackCaption(post, structuredContent, reelScript);

    try {
      const response = await this.glmClient.completeJson<CaptionResponse>(
        [
          {
            role: "system",
            content:
              "Write Instagram Reels captions for short viral AI videos. Return JSON only with keys caption, hashtags, firstComment. Keep it concise, emotional, and curiosity-driven. Avoid clickbait promises. End with CTA: Full prompts in Telegram.",
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                sourcePost: post,
                structuredContent,
                reelScript,
              },
              null,
              2,
            ),
          },
        ],
        0.6,
      );

      const hashtags = normalizeHashtagList(response.hashtags, fallback.hashtags)
        .map(normalizeHashtag)
        .filter(Boolean)
        .slice(0, 8);

      return {
        caption: truncate(
          (response.caption || fallback.caption).replace(/\n{3,}/g, "\n\n").trim(),
          2_100,
        ),
        hashtags: hashtags.length ? hashtags : fallback.hashtags,
        firstComment: response.firstComment?.trim() || fallback.firstComment,
      };
    } catch (error) {
      this.logger.warn(
        {
          sourcePostId: post.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Falling back to deterministic caption",
      );
      return fallback;
    }
  }

  private fallbackCaption(
    post: RawTelegramPost,
    structuredContent: StructuredTelegramContent,
    reelScript: ReelScript,
  ): CaptionPayload {
    const lines = [
      truncate(`POV: ${reelScript.idea}`, 180),
      truncate(structuredContent.hook, 180),
      truncate(`Twist: ${structuredContent.exampleResult}`, 220),
      "Full prompts in Telegram.",
    ];

    const firstComment = post.permalink ? `Source post: ${post.permalink}` : undefined;

    return {
      caption: lines.join("\n\n"),
      hashtags: reelScript.hashtags.length
        ? reelScript.hashtags
        : ["#ai", "#reels", "#viral", "#pov", "#contentcreator"],
      firstComment,
    };
  }
}

function normalizeHashtagList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === "string") {
    return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  }

  return fallback;
}
