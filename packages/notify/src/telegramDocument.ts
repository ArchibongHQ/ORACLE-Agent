/** Telegram document (file attachment) send — separate from TelegramNotifier's
 *  sendMessage path, since this needs a raw file path + caption, not a
 *  BatchSummary. Best-effort: never throws, silently no-ops on any failure
 *  (missing token, missing file, network error) so a report-attachment failure
 *  never blocks the rest of the run.
 *
 *  Tries undici fetch first; on a transport-level throw ("fetch failed" — the same
 *  undici DNS/TLS/IPv6 quirk that breaks TelegramNotifier in the Servy service
 *  context), falls back to node:https.request with a hand-built multipart body.
 *  This is why the daily HTML fixture report stopped arriving — fetch failed in
 *  the service and there was no fallback. */
import { existsSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

export async function sendTelegramDocument(
  botToken: string,
  chatId: string,
  filePath: string,
  caption: string
): Promise<void> {
  if (!botToken || !chatId || !existsSync(filePath)) return;
  const fileName = filePath.split(/[\\/]/).pop() ?? "report.html";
  const fileBuf = readFileSync(filePath);

  try {
    const form = new FormData();
    const blob = new Blob([fileBuf], { type: "text/html" });
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("document", blob, fileName);
    await fetch(API(botToken, "sendDocument"), {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // fetch threw (transport error) — retry via node:https with a manual multipart body.
    try {
      await postMultipartViaHttps(
        API(botToken, "sendDocument"),
        chatId,
        caption,
        fileName,
        fileBuf
      );
    } catch {
      /* best-effort — a report-attachment failure must never block the run */
    }
  }
}

/** node:https.request multipart/form-data POST — bypasses undici. Builds the body
 *  by hand: two text fields (chat_id, caption) + one binary file part (document). */
function postMultipartViaHttps(
  url: string,
  chatId: string,
  caption: string,
  fileName: string,
  fileBuf: Buffer
): Promise<void> {
  const boundary = `----oracle${Date.now().toString(16)}`;
  const textPart = (name: string, value: string): Buffer =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    );
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\n` +
      `Content-Type: text/html\r\n\r\n`
  );
  const body = Buffer.concat([
    textPart("chat_id", chatId),
    textPart("caption", caption),
    fileHeader,
    fileBuf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise<void>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": body.length,
        },
        timeout: 30_000,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("https.request timed out")));
    req.write(body);
    req.end();
  });
}
