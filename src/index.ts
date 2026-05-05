import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { z, type ZodTypeAny } from "zod";

type SchemaRecord = Record<string, ZodTypeAny>;

type InferSchemaData<TSchemas extends SchemaRecord> = {
  [K in keyof TSchemas]: z.infer<TSchemas[K]>;
};

interface ZevaDBOptions<TSchemas extends SchemaRecord> {
  path: string;
  schemas: TSchemas;
  initial: InferSchemaData<TSchemas>;
}

type Migration<TSchemas extends SchemaRecord> = (
  prevData: InferSchemaData<TSchemas>
) => InferSchemaData<TSchemas>;

interface NamedMigration<TSchemas extends SchemaRecord> {
  name: string;
  migrate: Migration<TSchemas>;
}

interface ZevaDBFile<TSchemas extends SchemaRecord> {
  _version: number;
  data: InferSchemaData<TSchemas>;
}

interface LockHandle {
  fileHandle: FileHandle;
  lockPath: string;
}

export class ZevaDB<TSchemas extends SchemaRecord> {
  private path: string;
  private lockPath: string;
  private schemas: TSchemas;
  public data: InferSchemaData<TSchemas>;
  private migrations: Array<NamedMigration<TSchemas>> = [];
  private readonly lockRetryDelayMs = 25;
  private readonly lockTimeoutMs = 5000;
  private readonly staleLockMs = 30000;

  constructor(options: ZevaDBOptions<TSchemas>) {
    this.path = options.path;
    this.lockPath = `${options.path}.lock`;
    this.schemas = options.schemas;
    this.data = structuredClone(options.initial);
  }

  addMigration(name: string, migration: Migration<TSchemas>) {
    this.migrations.push({ name, migrate: migration });
  }

  async read() {
    await this.withLock(async () => {
      let content: string;

      try {
        content = await fs.readFile(this.path, "utf-8");
      } catch (error: unknown) {
        if (this.isErrnoException(error) && error.code === "ENOENT") {
          await this.writeUnlocked();
          return;
        }

        throw new Error("[ZevaDB] Failed to read DB file.");
      }

      let fileDataUnknown: unknown;

      try {
        fileDataUnknown = JSON.parse(content);
      } catch (error: unknown) {
        console.error("[ZevaDB] Failed to parse DB file:", error);
        await this.backup();
        console.warn("[ZevaDB] Reinitializing DB to default state.");
        await this.writeUnlocked();
        return;
      }

      const DBFileSchema = z.object({
        _version: z.number().int().nonnegative(),
        data: z.object(this.schemas),
      });

      const parsedFile = DBFileSchema.safeParse(fileDataUnknown);

      if (!parsedFile.success) {
        console.error("[ZevaDB] DB file is invalid or corrupted:", parsedFile.error);
        await this.backup();
        console.warn("[ZevaDB] Reinitializing DB to default state.");
        await this.writeUnlocked();
        return;
      }

      let fileData = parsedFile.data as ZevaDBFile<TSchemas>;

      if (fileData._version > this.migrations.length) {
        throw new Error(
          `[ZevaDB] DB version ${fileData._version} is newer than available migrations (${this.migrations.length}).`
        );
      }

      let migrated = false;

      while (fileData._version < this.migrations.length) {
        const { name, migrate } = this.migrations[fileData._version]!;

        console.log(
          `[ZevaDB] Applying migration ${fileData._version + 1}: ${name}`
        );

        const migratedData = migrate(fileData.data);

        fileData = {
          data: migratedData,
          _version: fileData._version + 1,
        };
        migrated = true;
      }

      for (const key of this.schemaKeys()) {
        this.data[key] = this.parseCollection(key, fileData.data[key]);
      }

      if (migrated) {
        await this.writeUnlocked();
      }
    });
  }

  async write() {
    await this.withLock(async () => {
      await this.writeUnlocked();
    });
  }

  set<K extends keyof TSchemas>(key: K, newData: z.infer<TSchemas[K]>) {
    const validated = this.parseCollection(key, newData);

    this.data[key] = validated;
  }

  private async writeUnlocked() {
    const parsedData = {} as InferSchemaData<TSchemas>;

    for (const key of this.schemaKeys()) {
      parsedData[key] = this.parseCollection(key, this.data[key]);
    }

    const fileData: ZevaDBFile<TSchemas> = {
      _version: this.migrations.length,
      data: parsedData,
    };

    await this.writeAtomically(fileData);
  }

  private async writeAtomically(fileData: ZevaDBFile<TSchemas>) {
    const directory = dirname(this.path);
    await fs.mkdir(directory, { recursive: true });

    const tempPath = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    const stringified = JSON.stringify(fileData, null, 2);
    const tempFile = await fs.open(tempPath, "w");

    try {
      await tempFile.writeFile(stringified, "utf-8");
      await tempFile.sync();
    } finally {
      await tempFile.close();
    }

    try {
      await fs.rename(tempPath, this.path);
    } catch (error: unknown) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private async backup() {
    try {
      const backupPath = `${this.path}.backup-${Date.now()}`;
      await fs.rename(this.path, backupPath);
      console.warn(`[ZevaDB] Original DB backed up to ${backupPath}`);
    } catch (error: unknown) {
      if (this.isErrnoException(error) && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const lock = await this.acquireLock();

    try {
      return await action();
    } finally {
      await this.releaseLock(lock);
    }
  }

  private async acquireLock(): Promise<LockHandle> {
    const startedAt = Date.now();

    while (true) {
      try {
        const fileHandle = await fs.open(this.lockPath, "wx");
        await fileHandle.writeFile(String(process.pid), "utf-8");
        return { fileHandle, lockPath: this.lockPath };
      } catch (error: unknown) {
        if (this.isErrnoException(error) && error.code === "EEXIST") {
          await this.cleanupStaleLockIfNeeded();

          if (Date.now() - startedAt >= this.lockTimeoutMs) {
            throw new Error(`[ZevaDB] Timed out waiting for lock: ${this.lockPath}`);
          }

          await this.sleep(this.lockRetryDelayMs);
          continue;
        }

        throw error;
      }
    }
  }

  private async releaseLock(lock: LockHandle) {
    try {
      await lock.fileHandle.close();
    } finally {
      try {
        await fs.unlink(lock.lockPath);
      } catch (error: unknown) {
        if (this.isErrnoException(error) && error.code === "ENOENT") {
          return;
        }

        throw error;
      }
    }
  }

  private async cleanupStaleLockIfNeeded() {
    try {
      const stats = await fs.stat(this.lockPath);

      if (Date.now() - stats.mtimeMs < this.staleLockMs) {
        return;
      }

      await fs.unlink(this.lockPath).catch(() => undefined);
    } catch (error: unknown) {
      if (this.isErrnoException(error) && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  private isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error;
  }

  private schemaKeys(): Array<keyof TSchemas> {
    return Object.keys(this.schemas) as Array<keyof TSchemas>;
  }

  private parseCollection<K extends keyof TSchemas>(
    key: K,
    value: unknown
  ): z.infer<TSchemas[K]> {
    return this.schemas[key]!.parse(value) as z.infer<TSchemas[K]>;
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
