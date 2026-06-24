/** Telegram document (file attachment) send — separate from TelegramNotifier's
 *  sendMessage path, since this needs a raw file path + caption, not a
 *  BatchSummary. Mirrors apps/bot/src/index.ts's private sendDocumentTo
 *  (same multipart/form-data POST to sendDocument) — kept here so worker-side
 *  callers (apps/worker) don't need a dependency on @oracle/bot just to push a
 *  file attachment. Best-effort: never throws, silently no-ops on any failure
 *  (missing token, missing file, network error) so a report-attachment failure
 *  never blocks the rest of the run. */
import { existsSync, readFileSync } from "node:fs";

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

export async function sendTelegramDocument(
  botToken: string,
  chatId: string,
  filePath: string,
  caption: string
): Promise<void> {
  if (!botToken || !chatId || !existsSync(filePath)) return;
  try {
    const form = new FormData();
    const blob = new Blob([readFileSync(filePath)], { type: "text/html" });
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("document", blob, filePath.split(/[\\/]/).pop() ?? "report.html");
    await fetch(API(botToken, "sendDocument"), {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    /* best-effort — a report-attachment failure must never block the run */
  }
}
