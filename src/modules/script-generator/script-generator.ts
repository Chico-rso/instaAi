import { RawTelegramPost, ReelSceneKey, ReelScript, StructuredTelegramContent } from "../../types";
import { normalizeHashtag, truncate } from "../../utils/strings";
import { GlmClient } from "../../services/ai-client/glm-client";
import { AppLogger } from "../../services/logger";

interface RawReelScriptPayload {
  idea?: string;
  title?: string;
  subtitle?: string;
  visualNotes?: string;
  aiVideoPrompt?: string;
  hashtags?: string[];
  scenes?: Array<{
    key?: ReelSceneKey;
    title?: string;
    body?: string;
  }>;
}

const orderedSceneKeys: ReelSceneKey[] = ["hook", "setup", "escalation", "twist"];
const sceneDurations: Record<ReelSceneKey, number> = {
  hook: 2,
  setup: 3,
  escalation: 3,
  twist: 3,
};

export class ScriptGenerator {
  constructor(
    private readonly glmClient: GlmClient,
    private readonly logger: AppLogger,
  ) {}

  async generate(
    post: RawTelegramPost,
  ): Promise<{ structuredContent: StructuredTelegramContent; reelScript: ReelScript }> {
    const structuredContent = await this.normalizePost(post);
    const reelScript = await this.buildReelScript(structuredContent);

    return {
      structuredContent,
      reelScript,
    };
  }

  private async normalizePost(post: RawTelegramPost): Promise<StructuredTelegramContent> {
    const fallback = this.fallbackStructuredContent(post);

    try {
      const aiResult = await this.glmClient.completeJson<{
        hook: string;
        explanation: string;
        prompt: string;
        exampleResult: string;
      }>(
        [
          {
            role: "system",
            content:
              "Extract structured fields from a Telegram post about AI prompts. Return strict JSON only with keys hook, explanation, prompt, exampleResult. Preserve source meaning and avoid invented claims.",
          },
          {
            role: "user",
            content: `Telegram post:\n${post.text}`,
          },
        ],
        0.2,
      );

      return {
        sourcePostId: post.id,
        rawText: post.text,
        hook: truncate((aiResult.hook || fallback.hook).trim(), 140),
        explanation: truncate((aiResult.explanation || fallback.explanation).trim(), 260),
        prompt: truncate((aiResult.prompt || fallback.prompt).trim(), 340),
        exampleResult: truncate((aiResult.exampleResult || fallback.exampleResult).trim(), 260),
      };
    } catch (error) {
      this.logger.warn(
        {
          postId: post.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Falling back to deterministic Telegram parsing",
      );
      return fallback;
    }
  }

  private async buildReelScript(structuredContent: StructuredTelegramContent): Promise<ReelScript> {
    const fallback = this.fallbackReelScript(structuredContent);

    try {
      const payload = await this.glmClient.completeJson<RawReelScriptPayload>(
        [
          {
            role: "system",
            content:
              "You are an AI director for viral Instagram Reels. Return strict JSON only with keys idea, title, subtitle, visualNotes, aiVideoPrompt, hashtags, scenes. scenes must contain exactly 4 objects with keys hook, setup, escalation, twist. Keep each scene body very short and visual-first. Hook must be strong in first 2 seconds. Twist must be unexpected and end with CTA: 'Full prompts in Telegram'. Total pacing must fit 7-15 seconds with scene changes every 2-3 seconds.",
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                source: structuredContent,
                constraints: {
                  format: ["hook", "setup", "escalation", "twist"],
                  ctaText: "Full prompts in Telegram",
                  durationSec: 11,
                  maxBodyLength: 95,
                  emotionTargets: ["surprise", "curiosity"],
                  visualStyle:
                    "cinematic, high contrast, unusual visuals, fast transitions, vertical 9:16",
                },
              },
              null,
              2,
            ),
          },
        ],
        0.6,
      );

      return this.sanitizeReelScript(payload, fallback);
    } catch (error) {
      this.logger.warn(
        {
          sourcePostId: structuredContent.sourcePostId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Falling back to deterministic Reel script",
      );
      return fallback;
    }
  }

  private fallbackStructuredContent(post: RawTelegramPost): StructuredTelegramContent {
    const lines = post.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const sections: Partial<Record<keyof Omit<StructuredTelegramContent, "sourcePostId" | "rawText">, string[]>> = {};
    let activeKey: keyof Omit<StructuredTelegramContent, "sourcePostId" | "rawText"> | undefined;

    for (const line of lines) {
      const match = /^(hook|explanation|prompt|example result|result|example)\s*[:\-]?\s*(.*)$/i.exec(line);
      if (match) {
        const key = this.normalizeSectionKey(match[1]);
        activeKey = key;
        sections[key] = [];
        if (match[2]) {
          sections[key]?.push(match[2].trim());
        }
        continue;
      }

      if (activeKey) {
        sections[activeKey]?.push(line);
      }
    }

    const paragraphs = post.text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    return {
      sourcePostId: post.id,
      rawText: post.text,
      hook: truncate(
        sections.hook?.join(" ") || paragraphs[0] || lines[0] || "AI changed my content workflow overnight.",
        140,
      ),
      explanation: truncate(
        sections.explanation?.join(" ") || paragraphs[1] || paragraphs[0] || post.text,
        260,
      ),
      prompt: truncate(
        sections.prompt?.join(" ") ||
          paragraphs.find((paragraph) => /prompt/i.test(paragraph)) ||
          post.text,
        340,
      ),
      exampleResult: truncate(
        sections.exampleResult?.join(" ") || paragraphs.at(-1) || paragraphs[0] || post.text,
        260,
      ),
    };
  }

  private fallbackReelScript(structuredContent: StructuredTelegramContent): ReelScript {
    const scenes = [
      {
        key: "hook" as const,
        title: "Hook",
        body: truncate(structuredContent.hook, 95),
        durationSec: sceneDurations.hook,
      },
      {
        key: "setup" as const,
        title: "Setup",
        body: truncate(structuredContent.explanation, 95),
        durationSec: sceneDurations.setup,
      },
      {
        key: "escalation" as const,
        title: "Escalation",
        body: truncate(`Then this prompt flips the outcome: ${structuredContent.prompt}`, 95),
        durationSec: sceneDurations.escalation,
      },
      {
        key: "twist" as const,
        title: "Twist",
        body: truncate(`${structuredContent.exampleResult} Full prompts in Telegram.`, 95),
        durationSec: sceneDurations.twist,
      },
    ];

    return {
      idea: "POV: one AI prompt turns chaos into viral content.",
      title: truncate(structuredContent.hook, 80),
      subtitle: "Viral AI micro-story in 11s",
      ctaText: "Full prompts in Telegram",
      visualNotes: "Fast cuts every 2-3 seconds, high contrast, cinematic movement.",
      aiVideoPrompt: truncate(
        [
          "Vertical cinematic short video, 9:16, total 11 seconds.",
          "Scene 1 (0-2s): unusual hook visual related to AI and creators.",
          "Scene 2 (2-5s): setup with creator struggling in modern workspace.",
          "Scene 3 (5-8s): escalation with surreal AI transformation and fast camera movement.",
          "Scene 4 (8-11s): unexpected twist with clear Telegram CTA gesture.",
          "Dramatic lighting, social-media pacing, high detail, no logos.",
        ].join(" "),
        700,
      ),
      hashtags: ["#ai", "#reels", "#viral", "#pov", "#contentcreator", "#automation"],
      totalDurationSec: scenes.reduce((total, scene) => total + scene.durationSec, 0),
      scenes,
    };
  }

  private sanitizeReelScript(
    payload: RawReelScriptPayload,
    fallback: ReelScript,
  ): ReelScript {
    const incomingScenes = new Map<
      ReelSceneKey,
      {
        key?: ReelSceneKey;
        title?: string;
        body?: string;
      }
    >();

    const rawScenes = Array.isArray(payload.scenes) ? payload.scenes : [];
    for (const scene of rawScenes) {
      if (scene.key) {
        incomingScenes.set(scene.key, scene);
      }
    }

    const scenes = orderedSceneKeys.map((key) => {
      const scene = incomingScenes.get(key);
      const fallbackScene = fallback.scenes.find((item) => item.key === key)!;

      return {
        key,
        title: truncate((scene?.title || fallbackScene.title).trim(), 30),
        body: truncate(
          (scene?.body || fallbackScene.body).replace(/\s+/g, " ").trim() || fallbackScene.body,
          95,
        ),
        durationSec: sceneDurations[key],
      };
    });

    const hashtags = normalizeHashtagList(payload.hashtags, fallback.hashtags)
      .map(normalizeHashtag)
      .filter(Boolean)
      .slice(0, 8);

    return {
      idea: truncate((payload.idea || fallback.idea).replace(/\s+/g, " ").trim(), 110),
      title: truncate((payload.title || fallback.title).trim(), 80),
      subtitle: truncate((payload.subtitle || fallback.subtitle).trim(), 110),
      ctaText: "Full prompts in Telegram",
      visualNotes: truncate((payload.visualNotes || fallback.visualNotes).trim(), 180),
      aiVideoPrompt: truncate(
        (payload.aiVideoPrompt || fallback.aiVideoPrompt).replace(/\s+/g, " ").trim(),
        700,
      ),
      hashtags: hashtags.length ? hashtags : fallback.hashtags,
      totalDurationSec: scenes.reduce((total, scene) => total + scene.durationSec, 0),
      scenes,
    };
  }

  private normalizeSectionKey(
    value: string,
  ): keyof Omit<StructuredTelegramContent, "sourcePostId" | "rawText"> {
    if (/example result|result|example/i.test(value)) {
      return "exampleResult";
    }

    if (/hook/i.test(value)) {
      return "hook";
    }

    if (/prompt/i.test(value)) {
      return "prompt";
    }

    return "explanation";
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
