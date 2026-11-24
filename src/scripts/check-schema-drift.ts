#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Pool, PoolClient } from "pg";

const schemaFile = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "schema.sql",
);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to check schema drift.");
}

const rootSchemaSql = fs.readFileSync(schemaFile, "utf8");
const rootTables = [
  ...rootSchemaSql.matchAll(
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\s*\(/gi,
  ),
].map((match) => match[1].toLowerCase());

if (rootTables.length === 0) {
  throw new Error(`No tables found in ${schemaFile}.`);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const driftSchema = `schema_drift_${randomUUID().replace(/-/g, "")}`;

type SchemaSnapshot = {
  tables: string[];
  columns: string[];
  constraints: string[];
  indexes: string[];
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function normalizeDefinition(value: string, schema: string): string {
  const escapedSchema = schema.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value
    .replace(
      new RegExp(`(?:"${escapedSchema}"|${escapedSchema})\\.`, "gi"),
      "__schema__.",
    )
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function readSnapshot(
  client: PoolClient,
  schema: string,
): Promise<SchemaSnapshot> {
  const tablesResult = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
        AND table_name = ANY($2::text[])
      ORDER BY table_name`,
    [schema, rootTables],
  );
  const columnsResult = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    character_maximum_length: number | null;
    numeric_precision: number | null;
    numeric_scale: number | null;
    is_nullable: string;
    column_default: string | null;
    is_identity: string;
    identity_generation: string | null;
  }>(
    `SELECT table_name, column_name, data_type, udt_name,
            character_maximum_length, numeric_precision, numeric_scale,
            is_nullable, column_default, is_identity, identity_generation
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2::text[])
      ORDER BY table_name, ordinal_position`,
    [schema, rootTables],
  );
  const constraintsResult = await client.query<{
    table_name: string;
    constraint_name: string;
    constraint_type: string;
    definition: string;
  }>(
    `SELECT relation.relname AS table_name,
            constraint_row.conname AS constraint_name,
            constraint_row.contype AS constraint_type,
            pg_get_constraintdef(constraint_row.oid, true) AS definition
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[])
      ORDER BY relation.relname, constraint_row.conname`,
    [schema, rootTables],
  );
  const indexesResult = await client.query<{
    tablename: string;
    indexname: string;
    indexdef: string;
  }>(
    `SELECT tablename, indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = $1 AND tablename = ANY($2::text[])
      ORDER BY tablename, indexname`,
    [schema, rootTables],
  );

  return {
    tables: tablesResult.rows.map((row) => row.table_name),
    columns: columnsResult.rows.map((row) =>
      normalizeDefinition(
        [
          row.table_name,
          row.column_name,
          row.data_type,
          row.udt_name,
          row.character_maximum_length ?? "",
          row.numeric_precision ?? "",
          row.numeric_scale ?? "",
          row.is_nullable,
          row.column_default ?? "",
          row.is_identity,
          row.identity_generation ?? "",
        ].join("|"),
        schema,
      ),
    ),
    constraints: constraintsResult.rows.map((row) =>
      normalizeDefinition(
        [
          row.table_name,
          row.constraint_name,
          row.constraint_type,
          row.definition,
        ].join("|"),
        schema,
      ),
    ),
    indexes: indexesResult.rows.map((row) =>
      normalizeDefinition(
        [row.tablename, row.indexname, row.indexdef].join("|"),
        schema,
      ),
    ),
  };
}

function reportDifferences(
  label: string,
  expected: string[],
  actual: string[],
): boolean {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = [...expectedSet].filter((item) => !actualSet.has(item));
  const extra = [...actualSet].filter((item) => !expectedSet.has(item));

  for (const item of missing)
    console.error(`  Missing from migrated schema ${label}: ${item}`);
  for (const item of extra)
    console.error(`  Extra in migrated schema ${label}: ${item}`);
  return missing.length > 0 || extra.length > 0;
}

async function main(): Promise<void> {
  const client = await pool.connect();
  let schemaCreated = false;

  try {
    const currentSchemaResult = await client.query<{ schema_name: string }>(
      "SELECT current_schema() AS schema_name",
    );
    const currentSchema = currentSchemaResult.rows[0].schema_name;

    await client.query(`CREATE SCHEMA ${quoteIdentifier(driftSchema)}`);
    schemaCreated = true;
    await client.query(
      `SET search_path TO ${quoteIdentifier(driftSchema)}, ${quoteIdentifier(currentSchema)}`,
    );
    await client.query(rootSchemaSql);

    const expected = await readSnapshot(client, driftSchema);
    const actual = await readSnapshot(client, currentSchema);
    const differences = [
      reportDifferences("tables", expected.tables, actual.tables),
      reportDifferences("columns", expected.columns, actual.columns),
      reportDifferences(
        "constraints",
        expected.constraints,
        actual.constraints,
      ),
      reportDifferences("indexes", expected.indexes, actual.indexes),
    ].some(Boolean);

    if (differences) {
      throw new Error(
        "Schema drift detected between database/schema.sql and the applied migrations.",
      );
    }

    console.log(
      `Schema check passed for ${rootTables.length} root-schema table(s): columns, constraints, and indexes match.`,
    );
  } finally {
    try {
      if (schemaCreated) {
        await client.query(
          `DROP SCHEMA ${quoteIdentifier(driftSchema)} CASCADE`,
        );
      }
    } finally {
      client.release();
      await pool.end();
    }
  }
}

main().catch((error) => {
  console.error("Schema drift check failed:", error);
  process.exitCode = 1;
});
