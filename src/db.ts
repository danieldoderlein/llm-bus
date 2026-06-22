import pg from "pg";
import { loadConfig } from "./config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

/**
 * Initialize the connection pool. In Cloud SQL connector mode (CLOUD_SQL_INSTANCE set) this builds
 * an IAM-authed pool via the Cloud SQL Node connector and MUST be awaited at startup. In the default
 * direct-pool path it is a no-op (the pool is created lazily by getPool). Idempotent.
 */
export async function initPool(): Promise<void> {
  if (pool) return;
  const cfg = loadConfig();
  if (!cfg.CLOUD_SQL_INSTANCE) return;
  // Dynamic import so the connector dependency is only loaded in Cloud Run mode; the VM/test path
  // never requires it (decision 009). A direct pg pool is kept - no transaction-mode pooler in the
  // claim path (invariant 2).
  const { Connector, IpAddressTypes, AuthTypes } = await import("@google-cloud/cloud-sql-connector");
  const connector = new Connector();
  const opts = await connector.getOptions({
    instanceConnectionName: cfg.CLOUD_SQL_INSTANCE,
    ipType: IpAddressTypes[cfg.CLOUD_SQL_IP_TYPE],
    authType: AuthTypes.IAM,
  });
  pool = new Pool({ ...opts, user: cfg.CLOUD_SQL_IAM_USER, database: cfg.DB_NAME, max: 5 });
}

/** Lazily-created shared connection pool. */
export function getPool(): pg.Pool {
  if (!pool) {
    const cfg = loadConfig();
    if (cfg.CLOUD_SQL_INSTANCE) {
      throw new Error("Cloud SQL pool not initialized; await initPool() at startup before queries");
    }
    pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 20 });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

/** Run `fn` inside a single transaction, committing on success and rolling back on error. */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
