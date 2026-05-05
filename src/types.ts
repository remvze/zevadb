import type { FileHandle } from "node:fs/promises";
import { z } from "zod";

/** Map of collection names to Zod schemas. */
export type SchemaRecord = Record<string, z.ZodType>;

/** Infers the runtime data shape from a schema record. */
export type InferSchemaData<TSchemas extends SchemaRecord> = {
  [K in keyof TSchemas]: z.infer<TSchemas[K]>;
};

/** Configuration required to initialize a ZevaDB instance. */
export interface ZevaDBOptions<TSchemas extends SchemaRecord> {
  path: string;
  schemas: TSchemas;
  initial: InferSchemaData<TSchemas>;
}

/** A migration function that transforms persisted data to the next version. */
export type Migration<TSchemas extends SchemaRecord> = (
  prevData: InferSchemaData<TSchemas>
) => InferSchemaData<TSchemas>;

/** Named migration entry tracked by ZevaDB. */
export interface NamedMigration<TSchemas extends SchemaRecord> {
  name: string;
  migrate: Migration<TSchemas>;
}

/** On-disk representation of the database file. */
export interface ZevaDBFile<TSchemas extends SchemaRecord> {
  _version: number;
  data: InferSchemaData<TSchemas>;
}

/** Metadata required to manage a lock file lifecycle. */
export interface LockHandle {
  fileHandle: FileHandle;
  lockPath: string;
}
