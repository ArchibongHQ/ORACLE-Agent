import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mimeForFile, sendTelegramDocument, sendTelegramText } from "../src/telegramDocument.js";

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

  it("never throws when fetch resolves with a non-2xx status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "Forbidden" });
    await expect(
      sendTelegramDocument("TOKEN", "CHAT", filePath, "caption")
    ).resolves.toBeUndefined();
  });
});

describe("mimeForFile", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(mimeForFile("oracle-markets-2026-07-05-part1of2.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    expect(mimeForFile("report.HTML")).toBe("text/html");
    expect(mimeForFile("blob.weird")).toBe("application/octet-stream");
  });
});

describe("sendTelegramText", () => {
  it("posts JSON to the Telegram sendMessage endpoint", async () => {
    await sendTelegramText("TOKEN", "CHAT", "hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain("/botTOKEN/sendMessage");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toMatchObject({ chat_id: "CHAT", text: "hello" });
  });

  it("no-ops silently when botToken is empty", async () => {
    await sendTelegramText("", "CHAT", "hello");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops silently when chatId is empty", async () => {
    await sendTelegramText("TOKEN", "", "hello");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops silently when text is empty", async () => {
    await sendTelegramText("TOKEN", "CHAT", "");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(sendTelegramText("TOKEN", "CHAT", "hello")).resolves.toBeUndefined();
  });

  it("never throws when fetch resolves with a non-2xx status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "Forbidden" });
    await expect(sendTelegramText("TOKEN", "CHAT", "hello")).resolves.toBeUndefined();
  });
});
