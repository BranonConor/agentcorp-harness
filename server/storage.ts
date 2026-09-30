import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Room } from "./types.js";

export interface Store {
  read(): Promise<Room | null>;
  write(room: Room): Promise<void>;
}

export class FileStore implements Store {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  async read(): Promise<Room | null> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Room;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  write(room: Room): Promise<void> {
    const snapshot = JSON.stringify(room);
    const next = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
    });
    this.queue = next;
    return next;
  }
}
