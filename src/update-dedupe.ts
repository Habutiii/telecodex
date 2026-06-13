import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const UPDATE_TTL_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL = 100;

export class UpdateDeduper {
  private readonly dir: string;
  private seenCount = 0;

  constructor(botToken: string, baseDir = tmpdir()) {
    const tokenHash = createHash("sha256").update(botToken).digest("hex").slice(0, 16);
    this.dir = path.join(baseDir, "telecodex-update-dedupe", tokenHash);
  }

  shouldProcess(updateId: number, now = Date.now()): boolean {
    this.ensureDir();
    this.seenCount += 1;
    if (this.seenCount % CLEANUP_INTERVAL === 0) {
      this.cleanup(now);
    }

    const target = path.join(this.dir, `${updateId}.json`);
    if (existsSync(target)) {
      try {
        const recordedAt = Number.parseInt(readFileSync(target, "utf8"), 10);
        if (Number.isFinite(recordedAt) && now - recordedAt < UPDATE_TTL_MS) {
          return false;
        }
      } catch {
        // Fall through and overwrite invalid markers.
      }
    }

    try {
      writeFileSync(target, `${now}`, { encoding: "utf8", flag: "wx" });
      return true;
    } catch {
      try {
        const recordedAt = Number.parseInt(readFileSync(target, "utf8"), 10);
        if (Number.isFinite(recordedAt) && now - recordedAt < UPDATE_TTL_MS) {
          return false;
        }
        unlinkSync(target);
        writeFileSync(target, `${now}`, { encoding: "utf8", flag: "wx" });
        return true;
      } catch {
        return false;
      }
    }
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private cleanup(now: number): void {
    try {
      for (const entry of readdirSync(this.dir)) {
        const target = path.join(this.dir, entry);
        try {
          const recordedAt = Number.parseInt(readFileSync(target, "utf8"), 10);
          if (!Number.isFinite(recordedAt) || now - recordedAt >= UPDATE_TTL_MS) {
            unlinkSync(target);
          }
        } catch {
          unlinkSync(target);
        }
      }
    } catch {
      // Best-effort cleanup only.
    }
  }
}
