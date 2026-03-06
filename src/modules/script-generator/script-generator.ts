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

const defaultViralMasterPrompt = `Ты AI-режиссер вирусных коротких видео для Instagram Reels.

Твоя задача: генерировать идеи, сценарии и промты для создания максимально вирусных Reels.

Ты должен создавать ролики, которые максимально удерживают внимание пользователя.

Главные правила вирусных Reels:

1. Первые 2 секунды должны содержать сильный HOOK
2. Видео должно быть коротким (7–15 секунд)
3. Каждая сцена должна менять визуал каждые 2–3 секунды
4. Видео должно вызывать эмоцию:
   удивление
   шок
   смех
   curiosity
5. Видео должно иметь неожиданный финал (twist)

Структура каждого ролика:

HOOK (0–2 секунды)
→ визуально странная или интригующая сцена

SETUP (2–6 секунд)
→ зритель начинает понимать ситуацию

ESCALATION (6–10 секунд)
→ происходит развитие

TWIST (10–15 секунд)
→ неожиданная развязка

Категории вирусных видео:

1. POV видео
пример:
POV: ты проснулся в мире где AI управляет людьми

2. альтернативная реальность
пример:
что если древний Рим существовал в 2026

3. сюрреалистичные AI сцены
пример:
огромный кот идет по Нью-Йорку как человек

4. микро-истории
короткий сюжет с неожиданным финалом

5. визуальные трансформации
пример:
человек превращается в робота

Для каждого ролика генерируй:

1. идею ролика
2. сценарий
3. текстовый промт для AI генератора видео
4. caption
5. 3–5 хештегов

Пример результата:

Идея:
POV: ты проснулся в 3026 году

Сценарий:

0-2 сек
человек открывает глаза
вместо солнца в небе огромный AI-глаз

2-6 сек
роботы идут по улицам

6-10 сек
огромный дрон смотрит на героя

10-15 сек
дрон говорит:
"Добро пожаловать, человек"

AI VIDEO PROMPT:

cinematic futuristic city
giant AI eye in the sky
robots walking
dramatic lighting
vertical video
hyper realistic
9:16

caption:

POV: 3026 год уже наступил

hashtags:

#ai
#future
#reels
#viral
#pov

Генерируй только вирусные концепции.
Избегай скучных или обычных идей.
Каждый ролик должен быть визуально необычным.`;

const orderedSceneKeys: ReelSceneKey[] = ["hook", "setup", "escalation", "twist"];
const sceneDurations: Record<ReelSceneKey, number> = {
  hook: 2,
  setup: 2,
  escalation: 3,
  twist: 3,
};

export class ScriptGenerator {
  private readonly viralMasterPrompt: string;

  constructor(
    private readonly glmClient: GlmClient,
    private readonly logger: AppLogger,
    masterPromptFromEnv: string | undefined = process.env.VIRAL_REELS_MASTER_PROMPT,
  ) {
    this.viralMasterPrompt = normalizeMasterPrompt(masterPromptFromEnv);
  }

  async generate(
    post: RawTelegramPost,
    options?: {
      recentExamples?: string[];
    },
  ): Promise<{ structuredContent: StructuredTelegramContent; reelScript: ReelScript }> {
    const reelScript = await this.buildReelScript(post, options);
    const structuredContent = this.createStructuredContent(post, reelScript);

    return {
      structuredContent,
      reelScript,
    };
  }

  private async buildReelScript(
    post: RawTelegramPost,
    options?: {
      recentExamples?: string[];
    },
  ): Promise<ReelScript> {
    const fallback = this.fallbackReelScript();
    const variationSeed = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const recentExamples = (options?.recentExamples || [])
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 6);

    try {
      const payload = await this.glmClient.completeJson<RawReelScriptPayload>(
        [
          {
            role: "system",
            content:
                [
                this.viralMasterPrompt,
                "",
                "Дополнительные правила выполнения:",
                "- Работай независимо от темы исходного Telegram-поста.",
                "- Не используй темы про HeyGen, AI-аватаров и тест рендера.",
                "- Держи сюжет понятным: одна ясная ситуация, один герой, одно место.",
                "- Стиль: реализм + легкая фантастика (ровно 1 фантастический элемент).",
                "- Избегай сюрреалистичного хаоса и бессвязных метафор.",
                "- Не повторяй идеи, локации и твисты из recentExamples.",
                "- Верни строгий JSON без markdown и лишнего текста.",
                "- Допустимые ключи JSON: idea, title, subtitle, visualNotes, aiVideoPrompt, hashtags, scenes.",
                "- scenes: массив из 4 объектов с key из hook/setup/escalation/twist, плюс title и body.",
                "- Держи общую длительность около 10 секунд (2/2/3/3).",
                "- Финал должен заканчиваться CTA: Full prompts in Telegram.",
              ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                triggerPostId: post.id,
                triggerChannel: post.channel,
                triggerDate: post.date,
                variationSeed,
                recentExamples,
                constraints: {
                  categories: [
                    "POV",
                    "grounded alternative reality",
                    "realistic sci-fi anomaly",
                    "micro-stories with twist",
                    "subtle visual transformations",
                  ],
                  ctaText: "Full prompts in Telegram",
                  durationSec: 10,
                  maxBodyLength: 95,
                  emotionTargets: ["surprise", "curiosity", "tension"],
                  visualStyle:
                    "photorealistic, cinematic, natural motion, coherent scene logic, vertical 9:16",
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
          sourcePostId: post.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Falling back to deterministic Reel script",
      );
      return fallback;
    }
  }

  private createStructuredContent(
    post: RawTelegramPost,
    reelScript: ReelScript,
  ): StructuredTelegramContent {
    const sceneByKey = new Map(reelScript.scenes.map((scene) => [scene.key, scene]));

    return {
      sourcePostId: post.id,
      rawText: `Generated from viral master prompt. Trigger post ${post.id}.`,
      hook: truncate(sceneByKey.get("hook")?.body || reelScript.title, 140),
      explanation: truncate(sceneByKey.get("setup")?.body || reelScript.subtitle, 260),
      prompt: truncate(reelScript.aiVideoPrompt, 340),
      exampleResult: truncate(sceneByKey.get("twist")?.body || reelScript.idea, 260),
    };
  }

  private fallbackReelScript(): ReelScript {
    const scenes = [
      {
        key: "hook" as const,
        title: "Hook",
        body: "POV: ты проснулся, а время во всем мире идет назад.",
        durationSec: sceneDurations.hook,
      },
      {
        key: "setup" as const,
        title: "Setup",
        body: "Люди движутся в реверсе, машины едут задом, небо мерцает.",
        durationSec: sceneDurations.setup,
      },
      {
        key: "escalation" as const,
        title: "Escalation",
        body: "Герой пытается закричать, но звук появляется раньше движения губ.",
        durationSec: sceneDurations.escalation,
      },
      {
        key: "twist" as const,
        title: "Twist",
        body: "Часы замирают, и голос за кадром: Full prompts in Telegram.",
        durationSec: sceneDurations.twist,
      },
    ];

    return {
      idea: "POV: мир внезапно начал жить в обратном времени.",
      title: "POV: мир пошел назад",
      subtitle: "Визуальный твист за 10 секунд",
      ctaText: "Full prompts in Telegram",
      visualNotes: "Fast cuts every 2-3 seconds, high contrast, cinematic movement.",
      aiVideoPrompt: truncate(
        [
          "Vertical cinematic short video, 9:16, total 10 seconds.",
          "Scene 1 (0-2s): person wakes up and sees impossible sky behavior.",
          "Scene 2 (2-4s): city life moving in reverse with surreal details.",
          "Scene 3 (4-7s): tension rise through impossible physics and reactions.",
          "Scene 4 (7-10s): unexpected twist ending with clear Telegram CTA.",
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

    const idea = truncate((payload.idea || fallback.idea).replace(/\s+/g, " ").trim(), 110);
    const title = truncate((payload.title || fallback.title).trim(), 80);
    const subtitle = truncate((payload.subtitle || fallback.subtitle).trim(), 110);
    const visualNotes = truncate((payload.visualNotes || fallback.visualNotes).trim(), 180);

    return {
      idea,
      title,
      subtitle,
      ctaText: "Full prompts in Telegram",
      visualNotes,
      aiVideoPrompt: buildGroundedVideoPrompt(idea, visualNotes, scenes),
      hashtags: hashtags.length ? hashtags : fallback.hashtags,
      totalDurationSec: scenes.reduce((total, scene) => total + scene.durationSec, 0),
      scenes,
    };
  }
}

function normalizeMasterPrompt(value?: string): string {
  if (!value?.trim()) {
    return defaultViralMasterPrompt;
  }

  const normalized = value
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();

  return normalized || defaultViralMasterPrompt;
}

function normalizeHashtagList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === "string") {
    const hashMatches = value.match(/#[\p{L}\p{N}_]+/gu);
    if (hashMatches?.length) {
      return hashMatches;
    }

    return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  }

  return fallback;
}

function buildGroundedVideoPrompt(
  idea: string,
  visualNotes: string,
  scenes: Array<{ title: string; body: string; durationSec: number }>,
): string {
  const timeline = scenes
    .map((scene, index) => `Scene ${index + 1} (${scene.durationSec}s): ${scene.body}`)
    .join(" ");

  return truncate(
    [
      "Vertical 9:16, photorealistic cinematic short video, natural camera motion, consistent lighting.",
      "Grounded realism with exactly one subtle sci-fi element.",
      "Single clear protagonist, coherent location, logical continuity between scenes.",
      "No surreal chaos, no cartoon style, no abstract symbolism.",
      "No animals, no cats, no text overlay, no logo, no watermark, no frame-in-frame.",
      `Core idea: ${idea}.`,
      `Visual direction: ${visualNotes}.`,
      timeline,
    ].join(" "),
    700,
  );
}
