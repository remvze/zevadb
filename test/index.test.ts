import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ZevaDB } from "../src";

const buildDB = (path: string) => {
  return new ZevaDB({
    path,
    schemas: {
      posts: z.array(
        z.object({
          title: z.string(),
          content: z.string(),
        })
      ),
      users: z.array(
        z.object({
          email: z.string(),
          password: z.string(),
        })
      ),
    },
    initial: {
      posts: [],
      users: [],
    },
  });
};

const createTempDbPath = async () => {
  const dir = await mkdtemp(join(tmpdir(), "zevadb-test-"));
  return {
    dir,
    dbPath: join(dir, "db.json"),
  };
};

describe("ZevaDB", () => {
  it("initializes when file does not exist", async () => {
    const { dir, dbPath } = await createTempDbPath();

    try {
      const db = buildDB(dbPath);
      await db.read();

      const raw = await readFile(dbPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        _version: number;
        data: { posts: unknown[]; users: unknown[] };
      };

      expect(parsed._version).toBe(0);
      expect(parsed.data.posts).toEqual([]);
      expect(parsed.data.users).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("backs up malformed JSON and reinitializes", async () => {
    const { dir, dbPath } = await createTempDbPath();

    try {
      await writeFile(dbPath, "{ this is not json", "utf-8");
      const db = buildDB(dbPath);

      await db.read();

      const files = await readdir(dir);
      const backups = files.filter((name) => name.startsWith("db.json.backup-"));
      expect(backups.length).toBe(1);

      const raw = await readFile(dbPath, "utf-8");
      const parsed = JSON.parse(raw) as { data: { posts: unknown[]; users: unknown[] } };
      expect(parsed.data.posts).toEqual([]);
      expect(parsed.data.users).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("backs up schema-invalid file and reinitializes", async () => {
    const { dir, dbPath } = await createTempDbPath();

    try {
      await writeFile(
        dbPath,
        JSON.stringify(
          {
            _version: 0,
            data: {
              posts: "wrong",
              users: [],
            },
          },
          null,
          2
        ),
        "utf-8"
      );

      const db = buildDB(dbPath);
      await db.read();

      const files = await readdir(dir);
      const backups = files.filter((name) => name.startsWith("db.json.backup-"));
      expect(backups.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists migrations to disk", async () => {
    const { dir, dbPath } = await createTempDbPath();

    try {
      const db = buildDB(dbPath);
      await db.write();

      const next = new ZevaDB({
        path: dbPath,
        schemas: {
          posts: z.array(
            z.object({
              title: z.string(),
              content: z.string(),
              createdAt: z.string(),
            })
          ),
          users: z.array(
            z.object({
              email: z.string(),
              password: z.string(),
            })
          ),
        },
        initial: {
          posts: [],
          users: [],
        },
      });

      next.addMigration("Add createdAt to posts", (prev) => ({
        ...prev,
        posts: prev.posts.map((post) => ({
          ...post,
          createdAt: new Date().toISOString(),
        })),
      }));

      await next.read();

      const raw = await readFile(dbPath, "utf-8");
      const parsed = JSON.parse(raw) as { _version: number };
      expect(parsed._version).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses lock file during writes", async () => {
    const { dir, dbPath } = await createTempDbPath();

    try {
      const db = buildDB(dbPath);
      await db.read();

      db.data.users.push({ email: "a@x.com", password: "pw" });
      await db.write();

      const lockPath = `${dbPath}.lock`;
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

      const raw = await readFile(dbPath, "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
