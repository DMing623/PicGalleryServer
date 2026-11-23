// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * 会话/令牌签名密钥解析(issue §1.3)。
 *
 * 优先级:
 *  1. 显式配置且非占位值的 SESSION_SECRET;
 *  2. DATA_DIR/secret.key(0600)中已持久化的随机密钥;
 *  3. 生产环境(且非构建期)自动生成 32 字节随机密钥并落盘 —— 用户不配置也安全;
 *  4. 开发环境回落到由管理员密码派生(保持旧行为,便于本地调试)。
 *
 * 之所以做成同步读取:config 是模块级常量,被几乎所有服务端模块直接 import,
 * 不能改成异步。这里只做一次极小的同步 IO。
 */

const PLACEHOLDERS = new Set([
  "",
  "change-me-to-a-long-random-string",
  "change-me",
  "changeme",
  "secret",
  "your-secret",
  "pgs-derived:admin123456",
]);

export function isPlaceholderSecret(v: string | undefined | null): boolean {
  if (v === undefined || v === null) return true;
  const s = v.trim();
  return PLACEHOLDERS.has(s) || s.length < 32;
}

export function resolveSessionSecret(opts: {
  explicit: string | undefined;
  dataDir: string;
  adminPassword: string;
  isProduction: boolean;
  isBuild: boolean;
}): { secret: string; source: "env" | "file" | "generated" | "derived" } {
  const explicit = opts.explicit?.trim() ?? "";
  if (explicit && !isPlaceholderSecret(explicit)) return { secret: explicit, source: "env" };

  const file = path.join(opts.dataDir, "secret.key");
  try {
    const onDisk = fs.readFileSync(file, "utf8").trim();
    if (onDisk.length >= 32) return { secret: onDisk, source: "file" };
  } catch {
    /* 文件不存在:继续 */
  }

  if (opts.isProduction && !opts.isBuild) {
    const generated = randomBytes(32).toString("base64url");
    try {
      fs.mkdirSync(opts.dataDir, { recursive: true });
      fs.writeFileSync(file, generated, { mode: 0o600 });
      return { secret: generated, source: "generated" };
    } catch (e) {
      console.error("[secret] 无法写入 DATA_DIR/secret.key,本次使用临时随机密钥(重启后所有会话失效)", e);
      return { secret: generated, source: "generated" };
    }
  }

  return { secret: `pgs-derived:${opts.adminPassword}`, source: "derived" };
}
