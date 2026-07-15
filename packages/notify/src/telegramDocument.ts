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

/** MIME by file extension — Telegram mislabels the attachment if the part's
 *  Content-Type doesn't match (e.g. an .xlsx sent as text/html opens as gibberish).
 *  Defaults to octet-stream for anything unrecognised. Exported for the bot's
 *  own document sender. */
export function mimeForFile(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "csv":
      return "text/csv";
    case "html":
      return "text/html";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

export async function sendTelegramDocument(
  botToken: string,
  chatId: string,
  filePath: string,
  caption: string
): Promise<boolean> {
  if (!botToken || !chatId || !existsSync(filePath)) return false;
  const fileName = filePath.split(/[\\/]/).pop() ?? "report.bin";
  const fileBuf = readFileSync(filePath);
  const mime = mimeForFile(fileName);
  // Flat 30s was tuned for small payloads and timed out on large attachments
  // (e.g. the 12.3MB HTML fixture report) purely on upload bandwidth, not
  // latency — scale the budget with file size instead.
  const timeoutMs = 30_000 + Math.round((fileBuf.length / (1024 * 1024)) * 10_000);

  try {
    const form = new FormData();
    const blob = new Blob([fileBuf], { type: mime });
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("document", blob, fileName);
    const res = await fetch(API(botToken, "sendDocument"), {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Telegram sendDocument failed: ${res.status} ${await res.text()}`);
    return true;
  } catch {
    // fetch threw (transport error) — retry via node:https with a manual multipart body.
    try {
      await postMultipartViaHttps(
        API(botToken, "sendDocument"),
        chatId,
        caption,
        fileName,
        fileBuf,
        mime,
        timeoutMs
      );
      return true;
    } catch (err) {
      // best-effort — a report-attachment failure must never block the run, but it
      // must be visible in logs instead of vanishing silently.
      process.stderr.write(
        `[telegram-document] send failed — ${err instanceof Error ? err.message : String(err)}\n`
      );
      return false;
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
  fileBuf: Buffer,
  mime: string,
  timeoutMs: number
): Promise<void> {
  const boundary = `----oracle${Date.now().toString(16)}`;
  const textPart = (name: string, value: string): Buffer =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    );
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`
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
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `Telegram sendDocument failed: ${status} ${Buffer.concat(chunks).toString("utf8")}`
              )
            );
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("https.request timed out")));
    req.write(body);
    req.end();
  });
}

/** Send a plain text message to a chat — for short operational pings (e.g. "no
 *  fixtures today", "report on disk but delivery failed") that don't warrant a
 *  full BatchSummary through TelegramNotifier. Same fetch → node:https fallback as
 *  sendTelegramDocument. Best-effort: never throws, logs to stderr on hard failure. */
export async function sendTelegramText(
  botToken: string,
  chatId: string,
  text: string
): Promise<void> {
  if (!botToken || !chatId || !text) return;
  const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
  try {
    const res = await fetch(API(botToken, "sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  } catch {
    try {
      await postJsonViaHttps(API(botToken, "sendMessage"), body);
    } catch (err) {
      process.stderr.write(
        `[telegram-text] send failed — ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }
}

function postJsonViaHttps(url: string, body: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else
            reject(
              new Error(
                `Telegram sendMessage failed: ${status} ${Buffer.concat(chunks).toString("utf8")}`
              )
            );
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("https.request timed out")));
    req.write(body);
    req.end();
  });
}
