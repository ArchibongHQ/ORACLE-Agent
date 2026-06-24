import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendTelegramDocument } from "../src/telegramDocument.js";

let dir: string;
let filePath: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oracle-telegram-doc-"));
  filePath = join(dir, "report.html");
  await writeFile(filePath, "<html></html>", "utf8");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("sendTelegramDocument", () => {
  it("posts the file to the Telegram sendDocument endpoint", async () => {
    await sendTelegramDocument("TOKEN", "CHAT", filePath, "caption text");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { method: string; body: FormData }];
    expect(url).toContain("/botTOKEN/sendDocument");
    expect(opts.method).toBe("POST");
    expect(opts.body.get("chat_id")).toBe("CHAT");
    expect(opts.body.get("caption")).toBe("caption text");
  });

  it("no-ops silently when botToken is empty", async () => {
    await sendTelegramDocument("", "CHAT", filePath, "caption");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops silently when chatId is empty", async () => {
    await sendTelegramDocument("TOKEN", "", filePath, "caption");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops silently when the file does not exist", async () => {
    await sendTelegramDocument("TOKEN", "CHAT", join(dir, "nope.html"), "caption");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(
      sendTelegramDocument("TOKEN", "CHAT", filePath, "caption")
    ).resolves.toBeUndefined();
  });
});
