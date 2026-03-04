import { join } from "node:path";

import { InstagramAuthSession } from "../types";
import { readJsonFile, writeJsonFileAtomic } from "./json-file-store";

export class InstagramAuthStore {
  private readonly sessionPath: string;

  constructor(stateDir: string) {
    this.sessionPath = join(stateDir, "instagram-auth.json");
  }

  async getSession(): Promise<InstagramAuthSession | undefined> {
    return readJsonFile<InstagramAuthSession | undefined>(this.sessionPath, undefined);
  }

  async setSession(session: InstagramAuthSession): Promise<void> {
    await writeJsonFileAtomic(this.sessionPath, session);
  }
}
