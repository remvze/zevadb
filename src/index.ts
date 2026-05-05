import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import type {
  LockHandle,
  Migration,
  NamedMigration,
  SchemaRecord,
  ZevaDBFile,
  ZevaDBOptions,
} from "./types";
import {
  asDBFile,
  buildParsedData,
  createDBFileSchema,
  isErrnoException,
  parseCollection,
  schemaKeys,
  sleep,
} from "./utils";

export type {
  InferSchemaData,
  Migration,
  NamedMigration,
  SchemaRecord,
  ZevaDBFile,
  ZevaDBOptions,
} from "./types";

/**
 * A type-safe JSON file database with schema validation, migrations, and
 * corruption recovery.
 */
export class ZevaDB<TSchemas extends SchemaRecord> {
  private path: string;
  private lockPath: string;
  private schemas: TSchemas;
  public data: { [K in keyof TSchemas]: z.infer<TSchemas[K]> };
  private migrations: Array<NamedMigration<TSchemas>> = [];
  private readonly lockRetryDelayMs = 25;
  private readonly lockTimeoutMs = 5000;
  private readonly staleLockMs = 30000;

  /**
   * Creates a ZevaDB instance.
   */
  constructor(options: ZevaDBOptions<TSchemas>) {
    this.path = options.path;
    this.lockPath = `${options.path}.lock`;
    this.schemas = options.schemas;
    this.data = structuredClone(options.initial);
  }

  /**
   * Registers a migration that will run in sequence during `read()`.
   */
  addMigration(name: string, migration: Migration<TSchemas>) {
    this.migrations.push({ name, migrate: migration });
  }

  /**
   * Loads the database from disk, applies pending migrations, validates data,
   * and recovers from malformed or schema-invalid files.
   */
  async read() {
    await this.withLock(async () => {
      let content: string;

      try {
        content = await fs.readFile(this.path, "utf-8");
      } catch (error: unknown) {
        if (isErrnoException(error) && error.code === "ENOENT") {
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

      const parsedFile = createDBFileSchema(this.schemas).safeParse(
        fileDataUnknown,
      );

      if (!parsedFile.success) {
        console.error(
          "[ZevaDB] DB file is invalid or corrupted:",
          parsedFile.error,
        );

        await this.backup();

        console.warn("[ZevaDB] Reinitializing DB to default state.");

        await this.writeUnlocked();

        return;
      }

      let fileData = asDBFile<TSchemas>(parsedFile.data);

      if (fileData._version > this.migrations.length) {
        throw new Error(
          `[ZevaDB] DB version ${fileData._version} is newer than available migrations (${this.migrations.length}).`,
        );
      }

      let migrated = false;

      while (fileData._version < this.migrations.length) {
        const { name, migrate } = this.migrations[fileData._version]!;

        console.log(
          `[ZevaDB] Applying migration ${fileData._version + 1}: ${name}`,
        );

        const migratedData = migrate(fileData.data);

        fileData = {
          data: migratedData,
          _version: fileData._version + 1,
        };
        migrated = true;
      }

      for (const key of schemaKeys(this.schemas)) {
        this.data[key] = parseCollection(this.schemas, key, fileData.data[key]);
      }

      if (migrated) {
        await this.writeUnlocked();
      }
    });
  }

  /**
   * Persists the current in-memory state to disk.
   */
  async write() {
    await this.withLock(async () => {
      await this.writeUnlocked();
    });
  }

  /**
   * Replaces a full collection with schema-validated data.
   */
  set<K extends keyof TSchemas>(key: K, newData: z.infer<TSchemas[K]>) {
    const validated = parseCollection(this.schemas, key, newData);

    this.data[key] = validated;
  }

  /**
   * Serializes and writes validated data to disk without acquiring a lock.
   * Callers must ensure lock ownership.
   */
  private async writeUnlocked() {
    const parsedData = buildParsedData(this.schemas, this.data);

    const fileData: ZevaDBFile<TSchemas> = {
      _version: this.migrations.length,
      data: parsedData,
    };

    await this.writeAtomically(fileData);
  }

  /**
   * Writes to a temporary file and atomically renames it to avoid partial file
   * corruption.
   */
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

  /**
   * Backs up the current DB file using a timestamp suffix.
   */
  private async backup() {
    try {
      const backupPath = `${this.path}.backup-${Date.now()}`;

      await fs.rename(this.path, backupPath);

      console.warn(`[ZevaDB] Original DB backed up to ${backupPath}`);
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  /**
   * Runs an action under an exclusive lock file.
   */
  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const lock = await this.acquireLock();

    try {
      return await action();
    } finally {
      await this.releaseLock(lock);
    }
  }

  /**
   * Acquires a lock file and retries until timeout if the lock already exists.
   */
  private async acquireLock(): Promise<LockHandle> {
    const startedAt = Date.now();

    while (true) {
      try {
        const fileHandle = await fs.open(this.lockPath, "wx");

        await fileHandle.writeFile(String(process.pid), "utf-8");

        return { fileHandle, lockPath: this.lockPath };
      } catch (error: unknown) {
        if (isErrnoException(error) && error.code === "EEXIST") {
          await this.cleanupStaleLockIfNeeded();

          if (Date.now() - startedAt >= this.lockTimeoutMs) {
            throw new Error(
              `[ZevaDB] Timed out waiting for lock: ${this.lockPath}`,
            );
          }

          await sleep(this.lockRetryDelayMs);

          continue;
        }

        throw error;
      }
    }
  }

  /**
   * Releases a lock file after a protected action finishes.
   */
  private async releaseLock(lock: LockHandle) {
    try {
      await lock.fileHandle.close();
    } finally {
      try {
        await fs.unlink(lock.lockPath);
      } catch (error: unknown) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          return;
        }

        throw error;
      }
    }
  }

  /**
   * Removes the lock file if it is older than the stale lock threshold.
   */
  private async cleanupStaleLockIfNeeded() {
    try {
      const stats = await fs.stat(this.lockPath);

      if (Date.now() - stats.mtimeMs < this.staleLockMs) {
        return;
      }

      await fs.unlink(this.lockPath).catch(() => undefined);
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }
}
