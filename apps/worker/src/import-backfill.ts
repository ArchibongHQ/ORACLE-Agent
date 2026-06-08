/** import-backfill — reads flat JSON files produced by backfill_oracle.py
 *  and bulk-writes them into GBrainAdapter (PGLite) so the live worker
 *  can use historical calibration data.
 *
 * Usage: node dist/import-backfill.js [--store-dir .tmp/oracle-store] [--db-dir .tmp/gbrain]
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GBrainAdapter, STORAGE_KEYS } from "@oracle/storage";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "../../..");

function parseArgs(): { storeDir: string; dbDir: string } {
  const args = process.argv.slice(2);
  const idx = (flag: string) => args.indexOf(flag);
  return {
    storeDir:
      idx("--store-dir") >= 0 ? args[idx("--store-dir") + 1]! : join(ROOT, ".tmp/oracle-store"),
    dbDir: idx("--db-dir") >= 0 ? args[idx("--db-dir") + 1]! : join(ROOT, ".tmp/gbrain"),
  };
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { storeDir, dbDir } = parseArgs();
  const storage = new GBrainAdapter(dbDir);

  // Import analysis records
  const analysisPath = join(storeDir, `${safeKey(STORAGE_KEYS.analysisRecords)}.json`);
  const analyses = await readJsonFile<Record<string, unknown>[]>(analysisPath);
  if (analyses?.length) {
    await storage.bulkWrite(STORAGE_KEYS.analysisRecords, analyses);
  } else {
  }

  // Import resolution records
  const resPath = join(storeDir, `${safeKey(STORAGE_KEYS.resolutionRecords)}.json`);
  const resolutions = await readJsonFile<Record<string, unknown>[]>(resPath);
  if (resolutions?.length) {
    await storage.bulkWrite(STORAGE_KEYS.resolutionRecords, resolutions);
  } else {
  }

  await storage.close();
}

main().catch((_e) => {
  process.exit(1);
});
