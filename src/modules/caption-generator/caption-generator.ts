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
              "Write Instagram Reels captions for AI education content. Return JSON only with keys caption, hashtags, firstComment. Keep the caption concise, useful, and grounded in the source content. End with a call to action that points viewers to Telegram for full prompts.",
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

      const hashtags = (response.hashtags ?? fallback.hashtags)
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
      truncate(structuredContent.hook, 180),
      truncate(structuredContent.explanation, 280),
      `Prompt core: ${truncate(structuredContent.prompt, 280)}`,
      `Result: ${truncate(structuredContent.exampleResult, 220)}`,
      "Full prompts in Telegram.",
    ];

    const firstComment = post.permalink ? `Source post: ${post.permalink}` : undefined;

    return {
      caption: lines.join("\n\n"),
      hashtags: reelScript.hashtags.length
        ? reelScript.hashtags
        : ["#ai", "#automation", "#promptengineering", "#reelsmarketing"],
      firstComment,
    };
  }
}
