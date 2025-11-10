<div align="center">
  <h2>ZevaDB 📦</h2>
  <p>A typesafe JSON file database with Zod schema validation..</p>
  <a href="https://npmjs.com/package/zevadb"><strong>npm</strong></a> | <a href="https://buymeacoffee.com/remvze">Buy Me a Coffee</a>
</div>

### Features

- Fully type-safe collections powered by Zod
- Read/write JSON files with a single API
- `db.data` behaves like a normal object, fully typed
- `.set()` method for type-safe collection replacement
- Migration system for evolving your database schema
- Automatic backup of corrupted files
- TypeScript-first with full inference

### Installation

```bash
npm install zevadb zod
```

> **Note:** ZevaDB required Zod v4 as a peer dependency.

### Basic Usage

```ts
import { z } from "zod";
import { ZevaDB } from "zevadb";

// Define schemas
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

// Define schemas object
const schemas = {
  users: z.array(UserSchema),
  posts: z.array(PostSchema),
} as const;

// Create the database
const db = new ZevaDB({
  path: "./db.json",
  schemas,
  initial: {
    users: [],
    posts: [],
  },
});

await db.read(); // Load existing data or initialize

// Add a new user
db.data.users.push({ id: "1", name: "Alice" });

// Replace entire collection safely
db.set("users", [{ id: "2", name: "Bob" }]);

await db.write(); // Persist changes
```

### Type-Safe `.set()` Method

`db.set("collectionName", data)` replaces a collection safely with full type checking:

```ts
db.set("posts", [
  {
    id: "p1",
    title: "Hello World",
    content: "This is the first post",
    authorId: "1",
  },
]);
```

TypeScript will prevent invalid data according to your Zod schema.

### Migrations

ZevaDB includes a built-in migration system to evolve your data structure safely over time.

#### Adding a Migration

```ts
db.addMigration("Add createdAt to posts", (prevData) => {
  return {
    ...prevData,
    posts: prevData.posts.map((post) => ({
      ...post,
      createdAt: new Date().toISOString(), // add a new field
    })),
  };
});
```

- Each migration has a name and a function.
- Migrations are applied sequentially based on `_version`.
- After migrations, the database automatically updates its version and saves.

#### Migration Workflow

1. Add migrations before calling `db.read()`.
2. ZevaDB will:
   - Detect the current `_version` of the database file.
   - Apply all pending migrations sequentially.
   - Save the updated file after migration.
3. If the DB file is corrupted, ZevaDB will backup the old file and reinitialize.

### Backup and Recovery

ZevaDB automatically backs up the database before reinitializing in case of corruption:

```
db.json.backup-<timestamp>
```

You can inspect or restore backups manually if needed.
