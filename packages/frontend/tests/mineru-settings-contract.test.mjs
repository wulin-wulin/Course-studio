import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

async function readSource(relativePath) {
  return readFile(resolve(ROOT, "src", relativePath), "utf8");
}

test("MinerU settings dialog uses the dedicated safe settings endpoint", async () => {
  const source = await readSource("components/chat/MineruSettingsDialog.tsx");

  assert.match(source, /fetch\("\/api\/settings\/mineru"/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /document_parser/);
  assert.match(source, /mineru_api_base/);
  assert.match(source, /mineru_timeout_seconds/);
  assert.match(source, /mineru_model_version/);
  assert.match(source, /body\.mineru_api_token = token\.trim\(\)/);
  assert.match(source, /token\.trim\(\)\)/);
  assert.match(source, /不会写入浏览器缓存或课程内容/);
  assert.doesNotMatch(source, /localStorage\.(?:getItem|setItem).*token/i);
});

test("Agent panel exposes a visible MinerU configuration button", async () => {
  const source = await readSource("components/chat/AgentPanel.tsx");

  assert.match(source, /MineruSettingsDialog/);
  assert.match(source, /配置 MinerU 教材解析/);
  assert.match(source, /setMineruSettingsOpen\(true\)/);
  assert.match(source, />MinerU 设置<\/span>/);
});
