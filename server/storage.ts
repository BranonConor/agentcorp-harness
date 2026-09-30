import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LegacyRoom, Room } from "./types.js";

export interface Store {
  read(): Promise<Room | LegacyRoom | null>;
  write(room: Room): Promise<void>;
}

export class FileStore implements Store {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  async read(): Promise<Room | LegacyRoom | null> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Room | LegacyRoom;
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
