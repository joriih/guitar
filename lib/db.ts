import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { assertLoopbackDatabaseUrl } from "@/lib/local-database-url";

const DEFAULT_DATABASE_URL =
  "postgresql://riff_sketchbook_app@127.0.0.1:5432/riff_sketchbook";

declare global {
  var __riffSketchbookPool: Pool | undefined;
}

function createPool() {
  const databaseUrl = assertLoopbackDatabaseUrl(
    process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  );
  const databaseName = databaseUrl.pathname.slice(1);
  const databaseUser = decodeURIComponent(databaseUrl.username);
  const isolatedNamespace = process.env.AUDIO_STORAGE_NAMESPACE;
  const isMainDatabase =
    databaseName === "riff_sketchbook" && !isolatedNamespace;
  const isIsolatedE2e =
    typeof isolatedNamespace === "string" &&
    /^riff_sketchbook_e2e_[1-9][0-9]*_[a-f0-9]{10}$/.test(isolatedNamespace) &&
    databaseName === isolatedNamespace;
  if (
    databaseUser !== "riff_sketchbook_app" ||
    (!isMainDatabase && !isIsolatedE2e)
  ) {
    throw new Error("Riff Sketchbook 전용 로컬 데이터베이스만 사용할 수 있어요.");
  }
  const pool = new Pool({
    connectionString: databaseUrl.toString(),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "riff-sketchbook",
  });
  pool.on("error", (error) => {
    console.error("PostgreSQL idle connection error", error);
  });
  return pool;
}

export const db = globalThis.__riffSketchbookPool ?? createPool();

if (process.env.NODE_ENV !== "production") {
  globalThis.__riffSketchbookPool = db;
}

export class AmbiguousTransactionCommitError extends Error {
  constructor(public readonly commitError: unknown) {
    super(
      "PostgreSQL 연결이 COMMIT 응답 전에 끊겨 저장 완료 여부를 확인할 수 없어요.",
      { cause: commitError },
    );
    this.name = "AmbiguousTransactionCommitError";
  }
}

export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  let commitStarted = false;
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    commitStarted = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("PostgreSQL transaction rollback failed", rollbackError);
      releaseError =
        rollbackError instanceof Error
          ? rollbackError
          : new Error("PostgreSQL transaction rollback failed");
    }
    if (commitStarted) {
      throw new AmbiguousTransactionCommitError(error);
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export type DbRow = QueryResultRow;
