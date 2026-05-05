# ZevaDB

A type-safe JSON file database with Zod schema validation.

## Features

- Fully type-safe collections powered by Zod
- Type-safe `db.data` and `db.set()`
- Versioned migrations with automatic persistence after migration
- Corruption recovery with automatic backup files
- Atomic writes (temp file + rename)
- Cross-process write/read lock file to avoid concurrent file races

## Installation

```bash
npm install zevadb zod
```

> Note: ZevaDB requires Zod v4 as a peer dependency.

## Basic usage

```ts
import { z } from "zod";
import { ZevaDB } from "zevadb";

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const PostSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  authorId: z.string(),
});

const db = new ZevaDB({
  path: "./db.json",
  schemas: {
    users: z.array(UserSchema),
    posts: z.array(PostSchema),
  },
  initial: {
    users: [],
    posts: [],
  },
});

await db.read();

db.data.users.push({ id: "1", name: "Alice" });
db.set("users", [{ id: "2", name: "Bob" }]);

await db.write();
```

## Migrations

Add migrations before `read()`:

```ts
db.addMigration("Add createdAt to posts", (prevData) => {
  return {
    ...prevData,
    posts: prevData.posts.map((post) => ({
      ...post,
      createdAt: new Date().toISOString(),
    })),
  };
});

await db.read(); // pending migrations are applied and persisted
```

## Backup and recovery

If the database file is malformed or schema-invalid, ZevaDB moves it to a backup file and reinitializes from `initial`:

```text
<db-path>.backup-<timestamp>
```

## Concurrency notes

ZevaDB uses a lock file (`<db-path>.lock`) to serialize file operations across processes and reduces write corruption risk with atomic writes. In a multi-writer setup, last successful write still wins.
