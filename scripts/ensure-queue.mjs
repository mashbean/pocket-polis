#!/usr/bin/env node
// 部署前確保該環境的 Queue 存在。正式設定刻意與預設設定使用同一個
// Worker 與 Queue，讓自訂網域部署沿用既有 Durable Object namespace。
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function resolveQueueName(env, configText = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) {
  const stripped = configText
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const config = JSON.parse(stripped);
  const scope = env ? config.env?.[env] : config;
  const name = scope?.queues?.consumers?.[0]?.queue;
  if (typeof name !== "string" || !name) {
    throw new Error(`No queue consumer configured for environment "${env || "(default)"}" in wrangler.jsonc`);
  }
  return name;
}

function runWrangler(args) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const envName = process.argv[2] || "";
  // Workers Builds (Deploy button / Git integration) sets WORKERS_CI=1 and uses a
  // token that may not manage Queues. Wrangler creates the queue on first deploy
  // there, so skip the pre-check instead of failing closed.
  if (process.env.WORKERS_CI) {
    console.log(`WORKERS_CI detected; skipping queue pre-check for "${resolveQueueName(envName)}" (wrangler deploy provisions it).`);
    process.exit(0);
  }
  const queueName = resolveQueueName(envName);
  // 1. Check if queue already exists
  const info1 = runWrangler(["queues", "info", queueName]);
  if (info1.status === 0) {
    process.exit(0);
  }

  // 2. If info failed (nonzero exit), attempt to create the queue
  const create = runWrangler(["queues", "create", queueName]);
  if (create.status === 0) {
    process.exit(0);
  }

  // 3. If create failed (e.g. concurrent creation race), check info once more
  const info2 = runWrangler(["queues", "info", queueName]);
  if (info2.status === 0) {
    process.exit(0);
  }

  // 4. Fail closed: emit captured errors and exit with code 1
  console.error(`Failed to ensure queue "${queueName}":`);
  for (const [label, r] of [["info 1", info1], ["create", create], ["info 2", info2]]) {
    if (r.stderr || r.stdout) console.error(`[${label}]:\n${r.stderr || r.stdout}`.trim());
  }
  process.exit(1);
}
