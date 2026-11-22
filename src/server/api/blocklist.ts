// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { listBlocklist, purgeBlocked, unblock } from "../blocklist";
import { route } from "../router";

/**
 * 删除黑名单接口(仅管理者及以上:media.delete 权限)。
 *   GET    /blocklist              列出被排除的源文件
 *   POST   /blocklist/:id/restore  解除黑名单 → 恢复记录并重新生成缩略图
 *   DELETE /blocklist/:id          彻底删除(移除服务器源文件)
 */

route("GET", "/blocklist", "media.delete", async () => ({ items: await listBlocklist() }));

route("POST", "/blocklist/:id/restore", "media.delete", async (ctx) => unblock(ctx.params.id));

route("DELETE", "/blocklist/:id", "media.delete", async (ctx) => purgeBlocked(ctx.params.id));
