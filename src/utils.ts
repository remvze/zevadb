import { z } from "zod";

import type { InferSchemaData, SchemaRecord, ZevaDBFile } from "./types";

/**
 * Creates the schema that validates the persisted database payload.
 */
export const createDBFileSchema = <TSchemas extends SchemaRecord>(
  schemas: TSchemas
) => {
  return z.object({
    _version: z.number().int().nonnegative(),
    data: z.object(schemas),
  });
};

/**
 * Type guard for Node.js errno-style errors.
 */
export const isErrnoException = (
  error: unknown
): error is NodeJS.ErrnoException => {
  return typeof error === "object" && error !== null && "code" in error;
};

/**
 * Returns strongly typed schema keys.
 */
export const schemaKeys = <TSchemas extends SchemaRecord>(
  schemas: TSchemas
): Array<keyof TSchemas> => {
  return Object.keys(schemas) as Array<keyof TSchemas>;
};

/**
 * Parses a collection payload using its corresponding schema.
 */
export const parseCollection = <
  TSchemas extends SchemaRecord,
  K extends keyof TSchemas,
>(
  schemas: TSchemas,
  key: K,
  value: unknown
): z.infer<TSchemas[K]> => {
  return schemas[key]!.parse(value) as z.infer<TSchemas[K]>;
};

/**
 * Normalizes parsed file payloads back to the internal DB file type.
 */
export const asDBFile = <TSchemas extends SchemaRecord>(
  value: unknown
): ZevaDBFile<TSchemas> => {
  return value as ZevaDBFile<TSchemas>;
};

/**
 * Waits for a number of milliseconds.
 */
export const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Creates a validated data snapshot from in-memory state.
 */
export const buildParsedData = <TSchemas extends SchemaRecord>(
  schemas: TSchemas,
  data: InferSchemaData<TSchemas>
): InferSchemaData<TSchemas> => {
  const parsedData = {} as InferSchemaData<TSchemas>;

  for (const key of schemaKeys(schemas)) {
    parsedData[key] = parseCollection(schemas, key, data[key]);
  }

  return parsedData;
};
