import { randomUUID } from "node:crypto";

import { AppConfig } from "../config/env";
import { InstagramAuthSession } from "../types";
import { AppLogger } from "./logger";
import { InstagramAuthStore } from "./instagram-auth-store";

interface AccessTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  permissions?: string | string[];
  user_id?: string;
}

interface InstagramProfileResponse {
  id: string;
  username?: string;
  account_type?: string;
  user_id?: string;
  name?: string;
}

export class InstagramAuthService {
  constructor(
    private readonly config: AppConfig["instagram"],
    private readonly authStore: InstagramAuthStore,
    private readonly logger: AppLogger,
  ) {}

  getAuthorizationUrl(): string {
    if (!this.config.appId || !this.config.redirectUri) {
      throw new Error("INSTAGRAM_APP_ID or INSTAGRAM_REDIRECT_URI is not configured.");
    }

    const params = new URLSearchParams({
      client_id: this.config.appId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: this.config.scopes.join(","),
    });

    if (this.config.authMode === "instagram-login") {
      params.set("enable_fb_login", "0");
      params.set("force_authentication", this.config.forceReauth ? "1" : "0");
    }

    return `${this.config.authBaseUrl}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<InstagramAuthSession> {
    if (!this.config.appId || !this.config.appSecret || !this.config.redirectUri) {
      throw new Error("Instagram auth is not fully configured.");
    }

    const formData = new URLSearchParams({
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      grant_type: "authorization_code",
      redirect_uri: this.config.redirectUri,
      code,
    });

    const tokenResponse = await fetch(this.config.tokenBaseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData,
    });

    const tokenRaw = await tokenResponse.text();
    if (!tokenResponse.ok) {
      throw new Error(`Instagram token exchange failed: ${tokenRaw}`);
    }

    const tokenData = JSON.parse(tokenRaw) as AccessTokenResponse;
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      throw new Error("Instagram token exchange returned no access token.");
    }

    const profile = await this.fetchProfile(accessToken);
    const session: InstagramAuthSession = {
      accessToken,
      tokenType: tokenData.token_type,
      expiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1_000).toISOString()
        : undefined,
      issuedAt: new Date().toISOString(),
      scopes: this.normalizeScopes(tokenData.permissions),
      user: {
        id: profile.user_id || profile.id,
        username: profile.username,
        accountType: profile.account_type,
        name: profile.name,
      },
      raw: {
        token: tokenData as unknown as Record<string, unknown>,
        profile: profile as unknown as Record<string, unknown>,
      },
    };

    await this.authStore.setSession(session);
    this.logger.info(
      {
        username: session.user.username,
        userId: session.user.id,
      },
      "Stored Instagram auth session",
    );

    return session;
  }

  async getSession(): Promise<InstagramAuthSession | undefined> {
    return this.authStore.getSession();
  }

  createState(): string {
    return randomUUID();
  }

  private async fetchProfile(accessToken: string): Promise<InstagramProfileResponse> {
    const url = new URL(`${this.config.profileBaseUrl}/me`);
    url.searchParams.set("fields", "id,user_id,username,account_type,name");
    url.searchParams.set("access_token", accessToken);

    const response = await fetch(url);
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Instagram profile fetch failed: ${raw}`);
    }

    return JSON.parse(raw) as InstagramProfileResponse;
  }

  private normalizeScopes(value?: string | string[]): string[] {
    if (Array.isArray(value)) {
      return value;
    }

    if (typeof value === "string") {
      return value
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return this.config.scopes;
  }
}
