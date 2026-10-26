// Editor of a live content file (content/news.json, content/mail.json): list, create, replace and remove one entry.
// The whole document is validated with the same zod schema the readers use before it is written, and the write is
// atomic (temporary file + rename), so the hot-reloading reader (HotJsonFile, modification time) never sees a half file.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ZodError, type ZodType } from "zod";

import { AdminError } from "./admin-error.js";

type Entry = { id: string };

export type ContentEditorOptions<Doc, Item extends Entry> = {
  path: string;
  /** Key of the array in the document (`items`, `broadcasts`). */
  listKey: string;
  /** Validates the whole document (includes the duplicate id check). */
  documentSchema: ZodType<Doc>;
  itemSchema: ZodType<Item>;
  /** Extra rules that throw an Error with a readable message (e.g. unknown item ids in attachments). */
  check?: (item: Item) => void;
};

export function zodIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

export class ContentListEditor<Doc, Item extends Entry> {
  private readonly path: string;
  /** Edits of one file run one after the other (read-modify-write). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ContentEditorOptions<Doc, Item>) {
    this.path = resolve(options.path);
  }

  /** Every entry of the file as stored (also the ones not published yet or already expired). */
  async list(): Promise<Item[]> {
    return (await this.read()).entries;
  }

  async create(raw: unknown): Promise<Item[]> {
    return this.edit((entries) => {
      const item = this.parseItem(raw);
      if (entries.some((entry) => entry.id === item.id)) throw new AdminError("ADMIN_CONTENT_DUPLICATE_ID", 409, `id ${item.id} already exists`);
      return [...entries, item];
    });
  }

  async replace(id: string, raw: unknown): Promise<Item[]> {
    return this.edit((entries) => {
      const item = this.parseItem(raw);
      if (item.id !== id) throw new AdminError("ADMIN_INVALID_PAYLOAD", 400, "the id of an entry cannot change");
      if (!entries.some((entry) => entry.id === id)) throw new AdminError("ADMIN_CONTENT_NOT_FOUND", 404, `id ${id} not found`);
      return entries.map((entry) => (entry.id === id ? item : entry));
    });
  }

  async remove(id: string): Promise<Item[]> {
    return this.edit((entries) => {
      if (!entries.some((entry) => entry.id === id)) throw new AdminError("ADMIN_CONTENT_NOT_FOUND", 404, `id ${id} not found`);
      return entries.filter((entry) => entry.id !== id);
    });
  }

  // ------------------------------------------------------------------ internals

  private parseItem(raw: unknown): Item {
    const parsed = this.options.itemSchema.safeParse(raw);
    if (!parsed.success) throw new AdminError("ADMIN_INVALID_PAYLOAD", 400, "invalid entry", { issues: zodIssues(parsed.error) });
    try {
      this.options.check?.(parsed.data);
    } catch (error) {
      throw new AdminError("ADMIN_INVALID_PAYLOAD", 400, (error as Error).message, { issues: [{ path: "", message: (error as Error).message }] });
    }
    return parsed.data;
  }

  /** Reads the raw entries (others are written back exactly as they are), refusing a file that is already invalid. */
  private async read(): Promise<{ entries: Item[] }> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
      throw error;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw new AdminError("ADMIN_CONTENT_INVALID", 409, "the content file on disk is not valid JSON; fix it by hand first");
    }
    const parsed = this.options.documentSchema.safeParse(document);
    if (!parsed.success) throw new AdminError("ADMIN_CONTENT_INVALID", 409, "the content file on disk does not pass validation; fix it by hand first", { issues: zodIssues(parsed.error) });
    return { entries: ((document as Record<string, unknown>)[this.options.listKey] as Item[]) ?? [] };
  }

  private edit(change: (entries: Item[]) => Item[]): Promise<Item[]> {
    const run = async (): Promise<Item[]> => {
      const { entries } = await this.read();
      const next = change(entries);
      const document = { [this.options.listKey]: next };
      const checked = this.options.documentSchema.safeParse(document);
      if (!checked.success) throw new AdminError("ADMIN_INVALID_PAYLOAD", 400, "the content would not be valid", { issues: zodIssues(checked.error) });
      await this.writeAtomically(`${JSON.stringify(document, null, 2)}\n`);
      return next;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch((): void => undefined);
    return result;
  }

  private async writeAtomically(text: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, text, "utf8");
    await rename(temporary, this.path);
  }
}
