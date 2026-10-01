import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
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
      if (room.schemaVersion === 2 || room.schemaVersion === 3) {
        try {
          const previous = JSON.parse(await readFile(this.file, "utf8")) as { schemaVersion?: number };
          if (previous.schemaVersion === undefined || previous.schemaVersion === 2 && room.schemaVersion === 3) {
            const backupPath = `${this.file}.v${previous.schemaVersion ?? 1}.bak`;
            await copyFile(this.file, backupPath, constants.COPYFILE_EXCL).catch(async error => {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              if (await readFile(backupPath, "utf8") !== await readFile(this.file, "utf8")) {
                throw new Error(`Existing ${backupPath} differs from the current state; refusing migration without a matching backup.`);
              }
            });
            const backup = await open(backupPath, "r");
            try {
              await backup.chmod(0o600);
              await backup.sync();
            } finally { await backup.close(); }
          } else if (previous.schemaVersion !== room.schemaVersion) {
            throw new Error("Unknown state schema; refusing to overwrite it.");
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(snapshot);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, this.file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      const directory = await open(dirname(this.file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
