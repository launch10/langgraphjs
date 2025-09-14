import { getTablesWithSchema } from "./sql.js";

/**
 * To add a new migration, add a new string to the list returned by the getMigrations function.
 * The position of the migration in the list is the version number.
 */
export const getMigrations = (schema: string) => {
  const SCHEMA_TABLES = getTablesWithSchema(schema);
  return [
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.checkpoint_migrations} (
    v INTEGER PRIMARY KEY
  );`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.checkpoints} (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,
    checkpoint JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
  );`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.checkpoint_blobs} (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL,
    version TEXT NOT NULL,
    type TEXT NOT NULL,
    blob BYTEA,
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
  );`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.checkpoint_writes} (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT,
    blob BYTEA NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
  );`,
    `ALTER TABLE ${SCHEMA_TABLES.checkpoint_blobs} ALTER COLUMN blob DROP not null;`,
    `ALTER TABLE ${SCHEMA_TABLES.checkpoints} DROP CONSTRAINT checkpoints_pkey;`,
    `ALTER TABLE ${SCHEMA_TABLES.checkpoints}
    ADD COLUMN IF NOT EXISTS run_id UUID,
    ALTER COLUMN thread_id TYPE UUID USING (thread_id::uuid),
    ALTER COLUMN checkpoint_id TYPE UUID USING (checkpoint_id::uuid),
    ALTER COLUMN parent_checkpoint_id TYPE UUID USING (parent_checkpoint_id::uuid);`,
    `ALTER TABLE ${SCHEMA_TABLES.checkpoints}
    ADD CONSTRAINT checkpoints_pkey PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id);`,
    `CREATE INDEX IF NOT EXISTS checkpoints_run_id_idx ON ${SCHEMA_TABLES.checkpoints} (run_id);`,
    `CREATE INDEX IF NOT EXISTS checkpoints_checkpoint_id_idx ON ${SCHEMA_TABLES.checkpoints} (thread_id, checkpoint_id DESC);`,
    `ALTER TABLE ${SCHEMA_TABLES.checkpoint_writes} DROP CONSTRAINT checkpoint_writes_pkey;`,
    `ALTER TABLE ${SCHEMA_TABLES.checkpoint_writes}
      ALTER COLUMN thread_id TYPE UUID USING (thread_id::uuid),
      ALTER COLUMN checkpoint_id TYPE UUID USING (checkpoint_id::uuid),
      ALTER COLUMN task_id TYPE UUID USING (task_id::uuid),
      ALTER COLUMN type SET NOT NULL;`,
    `ALTER TABLE ${SCHEMA_TABLES.checkpoint_writes}
      ADD CONSTRAINT checkpoint_writes_pkey PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx);`,

    // New migrations for the checkpoint_blobs table
    `ALTER TABLE ${SCHEMA_TABLES.checkpoint_blobs} DROP CONSTRAINT checkpoint_blobs_pkey;`,
    `ALTER TABLE ${SCHEMA_TABLES.checkpoint_blobs} ALTER COLUMN thread_id TYPE UUID USING (thread_id::uuid);`,
    `ALTER TABLE ${SCHEMA_TABLES.checkpoint_blobs} ADD CONSTRAINT checkpoint_blobs_pkey PRIMARY KEY (thread_id, checkpoint_ns, channel, version);`,
  ];
};