/** export-store — dumps GBrainAdapter keys to flat JSON for Python tools (SkillOpt, etc.).
 *
 * Usage: node dist/export-store.js [--store-dir .tmp/oracle-store] [--db-dir .tmp/gbrain]
 *
 * Writes one JSON file per key into --store-dir, using the same filenames
 * that skillopt.py and backfill_oracle.py expect.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GBrainAdapter, STORAGE_KEYS } from '@oracle/storage';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '../../..');

function parseArgs(): { storeDir: string; dbDir: string } {
  const args = process.argv.slice(2);
  const idx  = (flag: string) => args.indexOf(flag);
  return {
    storeDir: idx('--store-dir') >= 0 ? args[idx('--store-dir') + 1]! : join(ROOT, '.tmp/oracle-store'),
    dbDir:    idx('--db-dir')    >= 0 ? args[idx('--db-dir')    + 1]! : join(ROOT, '.tmp/gbrain'),
  };
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

const EXPORT_KEYS = [
  STORAGE_KEYS.decisionDisagreementLog,
  STORAGE_KEYS.resolutionRecords,
  STORAGE_KEYS.analysisRecords,
  STORAGE_KEYS.calibrationLedger,
] as const;

async function main(): Promise<void> {
  const { storeDir, dbDir } = parseArgs();
  await mkdir(storeDir, { recursive: true });

  const storage = new GBrainAdapter(dbDir);
  let exported = 0;

  for (const key of EXPORT_KEYS) {
    const value = await storage.get<unknown>(key);
    if (value == null) {
      console.log(`[export] ${key}: (empty)`);
      continue;
    }
    const outPath = join(storeDir, `${safeKey(key)}.json`);
    await writeFile(outPath, JSON.stringify(value, null, 2), 'utf8');
    const count = Array.isArray(value) ? value.length : 1;
    console.log(`[export] ${key}: ${count} records → ${outPath}`);
    exported++;
  }

  await storage.close();
  console.log(`\n[export] Done — ${exported} keys exported to ${storeDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
