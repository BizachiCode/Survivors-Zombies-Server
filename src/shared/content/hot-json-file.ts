// A validated JSON content file that reloads itself when its modification time changes (live content edited while the
// server runs). A missing or broken file never takes the feature down: the last good version stays and the problem is logged.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError, type ZodType } from "zod";

import type { Logger } from "../logger.js";

export class HotJsonFile<T> {
  private readonly path: string;
  private version = "";
  private current: T;

  /**
   * @param empty value used until a valid file has been read
   * @param check extra validation that throws on unacceptable content (e.g. unknown item ids)
   */
  constructor(
    path: string,
    private readonly schema: ZodType<T>,
    empty: T,
    private readonly logger: Logger,
    private readonly check: (value: T) => void = () => {},
  ) {
    this.path = resolve(path);
    this.current = empty;
  }

  /** The current content (re-read first when the file changed). */
  get(): T {
    let version: string;
    try {
      const stat = statSync(this.path);
      version = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      if (this.version !== "missing") {
        this.version = "missing";
        this.logger.warn(`${this.path} not found; serving the last good content.`);
      }
      return this.current;
    }
    if (version === this.version) return this.current;
    this.version = version;
    try {
      const value = this.schema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      this.check(value);
      this.current = value;
      this.logger.info(`Loaded ${this.path}.`);
    } catch (error) {
      const reason = error instanceof ZodError ? error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ") : (error as Error).message;
      this.logger.error(`Invalid ${this.path}; keeping the previous content: ${reason}`);
    }
    return this.current;
  }
}
