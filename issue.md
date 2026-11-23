# PicGalleryServer 代码审查与优化建议(整合版 issue.md)

> 审查对象:`github.com/DMing623/PicGalleryServer` v1.2.0,`main` 分支,commit `619d96a`(feat(v1.2.0): 删除黑名单可反悔删除 / 父子相册不重复 / 水印更浅 / 相册管理文件夹式导航)
> 文档性质:**整合版**。第一轮由外部审查者做静态阅读产出原始 issue;第二轮由本助理逐条回到源码核对,补上证据、修正错误、追加遗漏项。本文件取代原始 issue.md,是后续优化的唯一依据。
> 审查方式:通读 `src/server/**`、`src/db/**`、`src/app/api/**`、`cli/pgs.mjs`、`Dockerfile`、`docker-compose.yml`、`.github/workflows/*`、`next.config.ts`、`public/sw.js`,以及部分前端组件。
> **局限**:全程**静态阅读**,未部署运行、未压测。凡涉及性能数字处均为数量级估算,以实际数据量(图片分辨率分布、并发数、容器内存限制)压测为准。行号对应 commit `619d96a`,后续改动会漂移,**请以函数名为准**。

---

## 0. 优化执行记录(2026-11-23,v1.3.0)

本轮按 §0.3 的优先清单逐条落地,**41 项已解决**(标题下方以 `✅ 已解决` 标注),9 项明确留待后续(以 `⏳ 本次未处理` 标注)。版本号同步升到 `1.3.0`。

| 分类 | 已解决 | 关键改动 |
|---|---|---|
| 数据安全 | §2.1 §2.2 §2.3 §2.4 §2.5 §2.6 | 扫描熔断 + `missing_at` 软删除、先搬文件后改库、`(size,mtime)` 变更与重命名识别、删除事务化、黑名单复用原 id、受管相册移交真正搬文件 |
| 认证与越权 | §1.1 §1.2 §1.3 §1.4 §1.11 | Basic 与登录共用 IP+用户名双维度限流、`TRUST_PROXY`、生产环境拒绝占位密码、`token_version`、改名冲突拒绝启动 |
| 输入与隐私 | §1.7 §1.8 §1.9 §11.3 §11.4 §11.5 | `GUEST_META` 裁剪 GPS/序列号、JSON 体积上限、`ALLOWED_HOSTS`、备注不再进 `search_text`、游客 `error` 置空、`robots.txt` + `X-Robots-Tag` |
| 挂载安全 | §1.10 | `realpath` + 默认白名单 + 重叠检查 + 只读挂载 + 不跟随符号链接 + `media.purge` 权限 |
| 性能与内存 | §6.1 §6.2 §6.3 §6.4 §6.6 §6.7 §6.9 | 分池并发、EXIF 只读头部、只选必要列、可见集合缓存、失效防抖、`pg_trgm`、队列游标、HD 不再复制缓冲 |
| 部署与运维 | §5.1 §5.4 §5.5 §5.6 §3.1 | tini + 非 root + healthcheck + jemalloc、连接池 `error` 监听、CI 工作流、`/status` 缓存、`X-Request-Id` 与 liveness/readiness 拆分 |
| CLI 与 API | §3.4 §4.1 §4.2 §4.3 §4.4 | `util.parseArgs`、`pgs login` 令牌、超时重试、`/media/exists` 幂等同步、blocklist 等新命令 |

**新增环境变量**:`TRUST_PROXY`、`ALLOWED_HOSTS`、`GUEST_META`、`GUEST_NOTE`、`SEARCH_RATE_PER_MIN`、`KEY_RATE_PER_MIN`、`VIDEO_CONCURRENCY`、`HEIC_CONCURRENCY`、`EXIF_READ_BYTES`、`MIN_FREE_DISK_MB`、`JSON_BODY_MAX_KB`、`DB_POOL_MAX`、`DB_STATEMENT_TIMEOUT_MS`、`DB_CONNECT_TIMEOUT_MS`、`DATABASE_SSL`、`SCAN_PRUNE_MAX_RATIO`、`SCAN_PRUNE_MIN_COUNT`(完整说明见 `.env.example`)。

**数据库变更**(启动时自动幂等升级,无需手工迁移):`pgs_users.token_version`、`pgs_albums.readonly`、`pgs_media.mtime_ms`、`pgs_media.missing_at`,以及 `pg_trgm` GIN 索引与 `status <> 'ready'` 部分索引。

**验证情况**:`tsc --noEmit` 与 `node --check cli/pgs.mjs` 通过;沙箱内无法启动 PostgreSQL(proot 环境不支持共享内存),因此**未做运行时联调与压测**,涉及 SQL 与并发行为的改动请在真实环境回归。

**v1.3.1 / v1.3.2 复查与实测修补(2026-11-23)**:对上述改动做代码复查并在 InstaBox 真机部署验证,发现并修复 6 处问题:
- §1.10 只读挂载仍可被 `purge` 物理删除 → `deleteMediaByIds` 与 `blocklist.purgeBlocked` 在 purge 前整体校验,命中只读挂载直接 403(避免「删记录、留文件」后被扫描重新入库)。
- §2.1 熔断把「上次已标记 `missing_at`」的记录算进比例,一次合法大批量删除会让后续扫描永久报错 → 改为只统计本次新消失,且判断前移到所有写库动作之前。
- §1.10 前端无只读感知 → 上传对话框禁用并提示、相册操作加「只读 ↔ 允许写入」、挂载对话框加只读勾选、设置页显示只读状态。
- CLI 无法关闭只读 → 新增 `--no-readonly`(`album mount` / `album set`)。
- **升级后数据目录不可写(实测)**:旧容器以 root 写入,`albums/derived/tmp` 属主为 root,v1.3.0 的 `USER node` 导致上传 `EACCES`(500)。现改为 root 启动入口脚本仅修正本系统子目录属主,再 `setpriv` 降权到 uid 1000 运行。
- 生产环境弱口令拦截已实测生效:`ADMIN_PASSWORD=admin123456` 会被拒绝启动。

---

## 0. 总览

### 0.1 本文档与原始 issue 的差异

本文档相对原始 issue 做了四类改动,阅读时请注意:

1. **补证据**:每条结论都标注了源码位置(`文件:行号` 或函数名),并注明"已核对属实"。
2. **修正 5 处**:原始 issue 中有 5 条在机制描述或建议上不准确,已在 §10 单独列出并给出正确表述。**动手前务必先读 §10**,否则会照着错误的方案改。
3. **新增 6 项**:原始 issue 漏掉的问题,集中在 §11。其中 3 项(备注搜索侧信道、`basicCache` 无上限、失败路径双倍 scrypt)与原 issue 的 P0 项互相放大,建议合并处理。
4. **重排优先级**:原 issue 的"最值得先做的 12 件事"基本成立,但 §2.1 与 §2.2 的排序应更靠前,且 §1.1/§1.2/§5.4 应合并为一个原子改动。新排序见 §0.3。

### 0.2 严重程度说明

| 标记 | 含义 |
|---|---|
| 🔴 P0 | 可能导致数据丢失、越权,或被公网直接利用。建议尽快修 |
| 🟠 P1 | 明显的隐患或设计缺陷,在特定部署/规模下会出问题 |
| 🟡 P2 | 优化、体验、可维护性 |
| 🟢 Idea | 功能扩展 |

### 0.3 修订后的优先清单(收益/成本比排序)

| # | 事项 | 级别 | 工作量 | 章节 | 备注 |
|---|---|---|---|---|---|
| 1 | 扫描时"目录暂时为空/盘没挂上"会批量删除记录 | 🔴 | 中 | §2.1 | 唯一会真正丢数据的一条,提到首位 |
| 2 | 移动 ext 文件先改库后移文件,失败后扫描会误删记录 | 🔴 | 小 | §2.2 | 与 #1 共用 `(size,mtime)` 比对逻辑 |
| 3 | Basic 认证绕过登录限流 + 失败路径双倍 scrypt | 🔴 | 小 | §1.1 / §11.2 | 两条必须一起修,否则只修一半 |
| 4 | `clientIp()` 信任 XFF 第一段,限流可伪造绕过 | 🔴 | 小 | §1.2 | 与 #3 同一处改动 |
| 5 | 默认/占位 `ADMIN_PASSWORD`、`SESSION_SECRET` 可直接启动 | 🔴 | 小 | §1.3 | |
| 6 | `pg.Pool` 无 `error` 监听 + 生产环境不缓存到 `globalThis` | 🟠 | 小 | §5.4 | 一行代码,避免进程被杀 |
| 7 | 游客可用搜索逐字探测管理员备注(`search_text` 含 `note`) | 🟠 | 小 | §11.3 | 原 issue 未发现,属真实侧信道 |
| 8 | 缩略图/预览/文件接口每次 `select *`(含大 jsonb `meta`) | 🟠 | 小 | §6.2 | |
| 9 | 游客每次请求重算可见相册集合 | 🟠 | 小 | §6.2 | 与 #8 同一处 |
| 10 | `THUMB_CONCURRENCY` 默认 15 + EXIF 整文件读入 + HEIC 全解码 → 易 OOM | 🟠 | 小 | §6.1 | |
| 11 | `invalidateAlbums()` 每个文件入库都调用,批量上传期间全表聚合 | 🟠 | 中 | §6.3 | |
| 12 | 全局搜索 `LIKE '%x%'` 全表扫,且公开接口无限流 | 🟠 | 中 | §6.4 | |
| 13 | GPS/相机序列号等 EXIF 对游客公开,无开关 | 🟠 | 小 | §1.7 | |
| 14 | Docker:`npm start` 作 PID 1、root 运行、无 healthcheck、未用 standalone | 🟠 | 小 | §5.1 | |
| 15 | 无 `robots.txt` / 派生图无 `X-Robots-Tag`,公开相册会被搜索引擎索引 | 🟠 | 小 | §11.5 | 原 issue 未发现 |

### 0.4 核对结论摘要

对原始 issue 抽查约 25 条指控,**全部能在源码中找到对应证据,未发现凭空捏造**。可信度评估 85–90%。存在问题的部分:

- **机制描述不准确 3 处**:§10.1(`rename` 覆盖)、§10.2(npm 信号转发)、§10.4(内存估算)
- **建议本身有误 1 处**:§10.3(附录 A.6 的 sharp 管线建议与现有设计冲突,照做会提高内存峰值)
- **风险判断偏差 1 处**:§10.5(下载密钥的"低熵爆破"不是主要风险)
- **遗漏 6 项**:§11

---

## 1. 安全隐患

### 🔴 1.1 Basic 认证绕过登录限流(可暴力破解)【已核对属实】

> ✅ **已解决(2026-11-23)** —— 失败计数已下沉到 verifyCredentials(),Basic 认证与登录接口共用 IP + 用户名双维度限流(10 次/10 分钟 / 20 次/10 分钟)。

**位置**:`src/server/auth.ts:169 authenticate()` → `:193 verifyCredentials()`;`src/server/api/auth.ts:22`。

**核对结果**:属实。`authenticate()` 对所有路由(含 `public`)都接受 `Authorization: Basic ...`,失败直接返回 `null`,**不经过** `checkLoginRate`。限流只在 `POST /auth/login` 里调用(`api/auth.ts:22`)。`router.ts:52` 的 `dispatch()` 对每个匹配路由都会执行 `await authenticate(req)`,包括 `access === "public"` 的分支。

**问题**:
- 攻击者可对任意 public 接口(如 `GET /api/v1/auth/me`、`GET /api/v1/media`)循环发送不同 Basic 凭据猜密码,该路径完全不受 10 次/10 分钟限制。
- 每次猜测都会跑一次 scrypt;若用户名不存在,`auth.ts:199` 还会额外跑一次 `hashPassword("timing-equalizer")` 做时序均衡——**一次失败 = 2 次 scrypt**。libuv 线程池默认仅 4 线程,这同时是 CPU/线程池 DoS,会拖慢所有文件 IO 与 sharp 任务。

**建议**:
1. 把失败计数下沉到 `verifyCredentials()`:任何一次密码校验失败都 `recordLoginFailure(ip)`,校验前都 `checkLoginRate(ip)`。需要把 `ip` 传进 `authenticate(req, ip)`。
2. 另加**按用户名**的失败计数(同一用户名 10 分钟内 20 次失败短暂锁定)。只按 IP 限流挡不住分布式猜测。
3. 更好的做法:**对外 API 不再接受管理员密码的 Basic 认证**,改为个人访问令牌(PAT,见 §3.3、§7.2)。CLI 先 `login` 换 token,再用 Bearer。

> scrypt:一种内存硬(memory-hard)的密码哈希算法,单次计算开销大,因此既保护密码又容易被用作 DoS 放大器。

### 🔴 1.2 `clientIp()` 信任客户端自带的 `X-Forwarded-For`【已核对属实】

> ✅ **已解决(2026-11-23)** —— 新增 TRUST_PROXY;默认只信任反代覆盖写入的 X-Real-IP,TRUST_PROXY=n 时取 XFF 倒数第 n 段,不再取可伪造的第一段。

**位置**:`src/server/router.ts:45`

```ts
const xf = req.headers.get("x-forwarded-for");
return (xf?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local").slice(0, 64);
```

**核对结果**:属实,取的是 XFF **第一段**,而这一段客户端可任意填写。`.slice(0, 64)` 只限制单个 key 的长度,**不限制 key 的数量**。

**问题**:
- `docker-compose.yml:48-49` 默认 `ports: "3000:3000"`,应用直接暴露公网。攻击者每个请求换一个 `X-Forwarded-For: 1.2.3.x`,登录限流、HD 限流、HD 异常检测与封禁**全部失效**。
- 即使前面有 Nginx,若用常见的 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,客户端自带值仍排在最前。README 写的是 `$remote_addr`(正确),但用户容易复制别的配置。
- 副作用:`fails`(登录)、`S.windows / distinct / strikes / blocked`(HD guard)这些 Map 都以 IP 为 key,伪造大量不同 IP 会让它们膨胀(有 30 秒 GC,但攻击期间仍会涨)。

**建议**:增加 `TRUST_PROXY` 环境变量,取值 `0`(默认,只用 socket 地址)、`1`(信任一层,取 XFF **最后一段**或倒数第 N 段),或 CIDR 白名单。Next.js 的 Route Handler 拿不到 socket 地址,可让反代统一写一个自定义头(如 `X-Real-IP`,并在反代层**覆盖**而非追加),应用只信任这个头,并在文档中说明。同时给这些 Map 加最大条目数(LRU)。实现见附录 A.1。

### 🔴 1.3 默认/占位密钥可以直接上线【已核对属实】

> ✅ **已解决(2026-11-23)** —— 生产环境检测到占位 ADMIN_PASSWORD 直接拒绝启动;SESSION_SECRET 缺失时自动生成并持久化到 DATA_DIR/secret.key(0600),与管理员密码解耦。

**位置**:`src/server/config.ts:43`(管理员密码)、`:52`(会话密钥);`docker-compose.yml`;`.env.example:6,8`。

**核对结果**:属实。

- `config.ts:43`:`ADMIN_PASSWORD` 缺省 `admin123456`。
- `config.ts:52`:`SESSION_SECRET` 缺省 `pgs-derived:${adminPassword}`。
- `.env.example:6` `ADMIN_PASSWORD=change-this-password`、`:8` `SESSION_SECRET=change-me-to-a-long-random-string`,这些占位值是**公开写在仓库里的**,照抄不改就能正常启动。

**后果**:签名密钥已知后,任何人都能伪造 HMAC 令牌,包括**播放令牌(stream token)**与**HD 令牌**。session 令牌需要 `uid`(随机 UUID),相对难猜,但密钥已知本身就不应存在。

**建议**:
1. 启动时检测:`NODE_ENV=production` 且(`SESSION_SECRET` 为空,或等于任一已知占位值,或长度 < 32),**直接拒绝启动并打印清晰提示**。管理员密码同理(拒绝 `admin123456`、`change-this-password`)。
2. 更友好的方案:首次启动自动生成随机 `SESSION_SECRET`,持久化到 `DATA_DIR/secret.key`(权限 0600),用户不配也安全。
3. 管理员密码缺失时,首次启动生成随机密码并只打印一次到日志。
4. `SESSION_SECRET` 与管理员密码解耦(现在改管理员密码会让所有会话失效)。

### 🟠 1.4 令牌无状态、不可撤销【已核对属实】

> ✅ **已解决(2026-11-23)** —— pgs_users 新增 token_version,令牌携带 v 并在 loadUser 时比对;改密码/管理员重置会自增,旧令牌立即失效。

**位置**:`src/server/auth.ts`:`issueSession / verifyToken / loadUser`;`sessionCookie()`(`:120`)。

**核对结果**:属实。session 令牌只含 `{uid, exp}`,有效期默认 30 天(`config.ts:53` `sessionDays`)。

- 登出只是清 Cookie(`clearCookie()`),**被盗的令牌/Bearer 仍然有效 30 天**。
- 用户修改密码、管理员重置密码、修改角色,都不会让旧令牌失效(禁用用户有效,因为 `loadUser` 会查 `disabled`)。
- 令牌里没有任何版本号或 `iat`。

**建议**:在 `pgs_users` 增加 `token_version`(整数,默认 0)或 `password_changed_at`。令牌带上 `v`,`loadUser` 比对;改密码/登出所有设备/重置密码时自增。再往后可做"会话表 + 设备列表 + 单设备登出"。同时建议把有效期默认值缩短(如 7 天)并支持滑动续期。

### 🟠 1.5 下载密钥(`?key=`)的几个问题【已核对属实,风险判断需修正】

> ✅ **已解决(2026-11-23)** —— 无效 key 校验加 IP 限流(KEY_RATE_PER_MIN);verifyKey 改为单条 UPDATE...RETURNING 一次往返完成校验与计数;新增 POST /keys/verify 与 POST /keys/revoke 避免明文进日志;密钥最小长度提到 16;文件接口加 Referrer-Policy: no-referrer。密钥范围/次数上限仍待做(见 §7.1 分享链接)。

**位置**:`src/server/keys.ts`;`src/server/files.ts:120-130 serveMedia()`;`src/server/api/admin.ts:35,42`。

**核对结果**:属实。`files.ts:124` `verifyKey(key, !rangeStart || rangeStart[1] === "0")` 证实"只在 Range 起点为 0 时计数"。

1. **密钥出现在 URL 里**:会进入反代访问日志、浏览器历史、`Referer`。HTML/Markdown 模板更鼓励把带 key 的链接贴到别处。建议给 `/f/*`、`/api/v1/media/*` 加 `Referrer-Policy: no-referrer`;同时提供"请求头携带"方式(`X-PGS-Key`)。
2. **无效 key 没有限流**:`verifyKey` 每次查库,失败只返回 403。⚠️ **风险判断需修正**:见 §10.5——主要风险不是"猜中低熵密钥",而是**未认证的 key 校验请求本身构成放大**(public 接口 + 每次一次 DB 查询)。
3. **密钥是"全局万能钥匙"**:一个密钥能取**所有**相册(含私有)的原图/原视频。发给朋友一张图的下载权限,等于发出整库权限(只要对方能拿到媒体 id)。建议密钥支持**范围**(某相册/某媒体/某标签)、**次数上限**、**流量上限**、可绑定 IP 段。这与 §7.1 的"分享链接"是同一功能。
4. `GET /keys/verify?key=`(`admin.ts:42`)与 `DELETE /keys?key=`(`admin.ts:35`)把明文密钥放进 query,会写进日志。建议改成 `POST /keys/verify`、`POST /keys/revoke` 并用 body。
5. 使用统计 `useCount` 只在 `Range` 起点为 0 时计数,但每次都要先 `SELECT` 再异步 `UPDATE`,高并发下是额外写放大。可合并成一条 `UPDATE ... WHERE key_hash=$1 AND (expires_at IS NULL OR expires_at>now()) RETURNING ...`,一次往返同时完成校验与计数。

### 🟠 1.6 视频"防下载"只防"手滑",不防脚本【已核对属实】

> ⏳ **本次未处理** —— 视频仍按「播放令牌 + Sec-Fetch-Dest 特征」放行原视频,未做 720p/HLS 转码预览。属于 §7.3 的独立功能,建议单独立项。

**位置**:`src/server/files.ts:110-145 serveMedia()`(`looksLikeMediaElement()` 判定)。

**核对结果**:属实。`files.ts:141` 仅凭 `Sec-Fetch-Dest: video` 放行 `stream` 变体,`curl -H 'Sec-Fetch-Dest: video' ...` 即可伪造;令牌从 `GET /media/:id` 的 JSON 里直接拿(游客可见公开相册)。`project.md` §14 已说明这不是 DRM,这点很诚实。

**建议**(若想真正降低风险):
- 给游客播放**转码后的低码率预览视频**(如 720p H.264 / HLS 分片),原始视频只在有 key 或登录用户有权限时才出。原视频泄露本就"不可控",但转码预览能把泄露价值降到很低,同时大幅节省带宽。
- 播放令牌绑定 IP 或 UA 摘要,并缩短有效期(现在 6 小时,`auth.ts:129`),HLS 分片用短期签名。

---

### 🟠 1.7 EXIF 隐私:GPS、序列号对游客公开【已核对属实】

> ✅ **已解决(2026-11-23)** —— 新增 GUEST_META(full|basic|none,默认 basic):游客不再拿到 GPS、机身/镜头序列号、作者/版权邮箱、raw 原始段与 PNG 文本;GUEST_NOTE 控制备注可见性(默认关闭)。

**位置**:`src/server/media/service.ts:125-145 mediaDetail()`。

**核对结果**:属实。`service.ts:136` `meta: (row.meta as MediaMeta | null) ?? null` 直接返回完整 `meta`;`service.ts:135` 还把 `error: row.error` 一并返回(见 §11.4)。`GET /media/:id` 是 `public`(`api/media.ts:33`),游客只要能看到公开相册里的这张图,就能拿到拍摄位置、机身序列号等。

**建议**:
- 新增站点设置 `guestMeta: "full" | "basic" | "none"`,默认 `basic`:游客只拿到宽高/格式/拍摄时间/相机型号/曝光参数,**去掉 GPS、序列号、`raw`、`userComment`、作者/版权邮箱等**。登录用户仍可看全部。
- 或者更细:相册级别的"对游客隐藏位置"开关。
- 管理员备注 `note` 目前也对游客可见(`service.ts:134`)。若这是设计意图可保留,但建议给开关,避免有人把内部备注写进去。**注意**:`note` 还会进入 `search_text`,构成侧信道,见 §11.3。

### 🟠 1.8 请求体大小/类型没有限制【已核对属实】

> ✅ **已解决(2026-11-23)** —— readJson 改为流式读取并限制体积(JSON_BODY_MAX_KB,默认 1MB)且校验 Content-Type;parseUpload 支持 maxBytes 边收边截断(图标 2MB);MAX_UPLOAD_MB 默认 2048;上传前检查剩余磁盘(MIN_FREE_DISK_MB)。

**位置**:`src/server/http.ts:42-52 readJson()`;`src/server/media/upload.ts:22-35 parseUpload()`;`src/server/api/auth.ts:79-105 /settings/icon`。

**核对结果**:属实。

1. `readJson` 用 `req.text()` 整体读入内存,**没有大小上限**(`http.ts:44`)。`POST /auth/login`(public)就会读,**未登录用户即可用大 body 消耗内存**。建议:先检查 `Content-Length`,并用带上限的流式读取(如 1MB)。
2. 不校验 `Content-Type: application/json`。Cookie 是 `SameSite=Lax`(`auth.ts:121`),跨站 POST 不带 Cookie,实际 CSRF 风险有限;但对同站子域、旧浏览器、以及将来若放宽 SameSite 是隐患。建议对 Cookie 认证的非安全方法(POST/PUT/PATCH/DELETE)强制 `application/json` 或 multipart,并检查 `Origin` 与 `Host` 同源。
3. 上传:`MAX_UPLOAD_MB=0`(默认不限,`config.ts:66`)+ 无总大小/磁盘剩余检查。`uploader` 角色可一次写满磁盘。`parseUpload` 最多 5000 个文件(`upload.ts:35` `files: 5000`),总量不限。建议:默认给合理上限(如 2048MB);上传前检查 `statfs` 剩余空间 > X;按用户配额。
4. `/settings/icon`(`api/auth.ts:79`)同样调用 `parseUpload`,在 `maxUploadMb=0` 时先把任意大文件写进 tmp,**写完才检查 2MB**(`api/auth.ts:83`)。应给 `parseUpload` 传 `maxBytes` 参数,边收边截断。

### 🟠 1.9 Host / Forwarded-Host 头注入【已核对属实】

> ✅ **已解决(2026-11-23)** —— baseUrl() 增加 ALLOWED_HOSTS 白名单校验,不在白名单时回落到请求自身 host;水印层缓存变体上限提到 24 且按 LRU 淘汰。

**位置**:`src/server/media/service.ts` `baseUrl()`;`src/server/hd/service.ts:177-184`(水印 host 来源)。

**核对结果**:属实。`hd/service.ts:179` 的 `new URL(baseUrl(req)).host` 直接取请求头拼出的 host。

没配置 `PUBLIC_BASE_URL` 时,文件链接直接用请求里的 `x-forwarded-host` / `host` 拼出,HD 水印文字里的 `{host}` 也来自它。攻击者可构造 Host 让 API 返回指向恶意域名的链接(链接投毒),或用大量不同 Host 击穿 `layerCache`(`watermark.ts:57`,每个不同 host 都重新合成一层 PNG 水印,CPU 成本不低;`:116` 仅在 `size > 12` 时逐个淘汰)。

**建议**:提供 `ALLOWED_HOSTS` 白名单(默认取 `PUBLIC_BASE_URL` 的 host);不在白名单内就回落到 `PUBLIC_BASE_URL` 或直接 400。生产环境未设 `PUBLIC_BASE_URL` 时,启动日志给出警告。

### 🟠 1.10 挂载目录:符号链接逃逸、无重叠检查、读写权限太宽【已核对属实】

> ✅ **已解决(2026-11-23)** —— assertMountAllowed 改为 async 并先 realpath;白名单为空时只允许数据目录与 /photos、/mnt、/media、/srv、/home、/volume1;新增祖先/后代重叠检查;挂载相册新增 readonly 属性(默认 true),只读时拒绝上传/移动/物理删除;collectFiles 改用 lstat 不跟随符号链接;物理删除需要新增的 media.purge 权限(仅 admin)。

**位置**:`src/server/albums.ts` `assertMountAllowed / mountDir`;`src/server/media/ingest.ts:204-215 collectFiles()`。

**核对结果**:属实。`ingest.ts:204` 用 `fs.stat`(会跟随符号链接);`config.ts:70` `ALLOWED_MOUNT_ROOTS` 默认为空 = 不限制。

1. `ALLOWED_MOUNT_ROOTS` 只做字符串前缀比较,**没有 `fs.realpath`**。允许目录里放一个指向 `/etc`、`/root` 的符号链接,`path.resolve` 不解析它。扫描用 `Dirent`(不跟随符号链接)相对安全;但 `collectFiles`(导入)用 `fs.stat`(跟随),导入路径可绕出去。建议统一 `realpath` 后再比较。
2. `ALLOWED_MOUNT_ROOTS` 默认为空 = **不限制**,`/fs/browse` 能浏览整个文件系统(容器里还好,裸机就是整机)。建议默认要求显式配置;未配置时只允许 `/photos`、`DATA_DIR` 等约定目录,或启动时警告。
3. 没有"重叠挂载"检查。允许同时挂载 `/srv/photos` 和 `/srv/photos/2024`(唯一索引只拦完全相同的 `root_path`)。两棵树会互相"抢"文件:谁先扫描,文件记录就属于谁,另一边的 `gone` 逻辑会把它当消失而删记录。挂载时应检查祖先/后代关系并拒绝。
4. 没有**只读挂载**概念。`manager` 可 `DELETE /media/:id?purge=1`、`PATCH /media/:id {album}`(会真的 `rename` 磁盘文件)。README 示例把照片目录以读写方式挂进容器。建议给挂载相册加 `readonly` 属性(默认 `true`):只读时拒绝 purge、移动、上传、重命名,UI 灰掉相应按钮;compose 示例默认写 `:ro`。
5. `purge` 物理删除应只允许 `admin`(或新权限 `media.purge`),`manager` 的"删除"保持"排除/回收站"。

### 🟡 1.11 其它安全相关的小问题【已核对属实】

> ✅ **已解决(2026-11-23)** —— next.config.ts 补齐全局安全头(nosniff / X-Frame-Options / Referrer-Policy / Permissions-Policy),/f/* 用 no-referrer;/api/v1/media/* 与 /f/* 加 X-Robots-Tag;syncEnvAdmin 改名冲突改为拒绝启动而不是删除用户;派生图 max-age 从 86400 降到 300。randomId 取模偏差未改(影响可忽略)。

- **没有全局安全响应头**:`next.config.ts` 只配了 3 条缓存头(sw.js、hd、hd-token),无 `X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`、CSP、HSTS。建议补齐(`/f/*` 用 `no-referrer`,其余 `strict-origin-when-cross-origin`)。
- **`syncEnvAdmin` 的改名分支会删除别的用户**(`auth.ts:222`):`if (patch.username) await db.delete(users).where(eq(users.username, patch.username));`。若把 `ADMIN_USER` 改成已存在的普通用户名,会**直接删掉那个用户**。建议改为"冲突就拒绝启动并提示"。
- **`randomId` 有取模偏差**(`media/types.ts:42-48`:`chars[b % 36]`,256 不能被 36 整除)。对 12 位 id 影响很小;若把 id 当"不可猜测"的一部分,建议拒绝采样或 `randomBytes` + base32。
- **登录响应同时返回 token 和 Cookie**,没有区分"浏览器会话"与"API 令牌"。见 §3.3。
- **`/security/watermark?code=`** 对所有用户做 `userMarkCode` 全量遍历,仅管理员可用,无碍。
- **缩略图缓存头**:游客拿到 `public, max-age=86400`(`files.ts:63`)。管理员把相册从公开改私有后,CDN/浏览器仍会缓存 24 小时。建议文档说明,或缩短时长并提供"立即清除"指引。**注**:`serveDerived` 已带 `ETag`(`files.ts:57`),支持 304,这点比原始 issue 描述的要好——真正的问题是 `max-age` 太长且无版本参数。
- **子资源完整性**:Splash 的 `iframe` 已加 `sandbox="allow-scripts"` 和 `referrerPolicy`,做得好;但未限制可嵌入域名,可在 CSP 用 `frame-src` 收紧。

---

## 2. 数据完整性与可靠性

### 🔴 2.1 扫描"目录暂时为空"会批量删除记录【已核对属实,最危险的一条】

> ✅ **已解决(2026-11-23)** —— 扫描新增熔断(SCAN_PRUNE_MAX_RATIO 默认 0.3、SCAN_PRUNE_MIN_COUNT 默认 20),超比例直接中止清理并报错;新增 pgs_media.missing_at 软删除,首次缺失只打标记并从列表隐藏,超过 7 天宽限期才真正清理,文件重新出现自动恢复;子目录消失同样打标记而不是留幽灵相册。

**位置**:`src/server/albums.ts:454-530 scanOne()`,关键在 `:519-523`。

**核对结果**:属实,且**没有任何熔断**:

```ts
const gone = existing.filter((r) => !seen.has(r.key)).map((r) => r.id);
if (gone.length) {
  ...
  await deleteMediaByIds(gone, false, { block: false });
  s.removed += gone.length;
}
```

`deleteMediaByIds(gone, false, ...)` 的 `purge=false` 只删记录不删文件(见 `albums.ts:341`),所以"文件没被物理删除"这一描述正确。

**问题**:`scanAlbum` 只检查"根目录存在且是目录"。常见场景:NAS 未挂载、docker 里宿主机目录没挂上、`autofs` 超时,这时挂载点是**存在但为空的目录**。`readdir` 返回空 → `existing` 全部进 `gone` → 整个相册的记录(以及备注、手动封面、已生成的缩略图与 HD 缓存)全删。文件虽在,但下次挂载恢复后所有记录都是新 id:**备注丢失、旧的 `/f/<id>` 外链全部失效**。

**建议**(由轻到重,建议 1+2 都做):
1. **熔断**:若本次扫描"消失文件数 / 已知文件数 > 30%"(或全部消失且已知 > N),**中止删除**,状态标 `error`,让管理员确认。实现见附录 A.7。
2. **软删除**:给 `pgs_media` 增加 `missing_at`,第一次发现不存在只打标记并从列表隐藏,连续 N 次扫描(或超过 X 天)仍缺失才真正清理;文件重新出现就清标记,id 与备注都保留。
3. 子目录同理:`scanOne` 在目录消失时**根本不会递归进去**,所以子相册及其记录会永远残留成"幽灵相册"。需在扫描父目录时对比子相册与实际子目录,消失的做软处理。

### 🔴 2.2 移动 ext 文件:先改库、后搬文件,失败后会被扫描"误删"【已核对属实】

> ✅ **已解决(2026-11-23)** —— 改为「先移动文件、成功后再改库」;移动用 fs.link + unlink(跨盘回落 COPYFILE_EXCL),目标已存在即 EEXIST 失败,消除 TOCTOU 覆盖;失败会向上抛出并在 batch move 的逐项结果里返回原因。

**位置**:`src/server/media/service.ts:178-181 updateMedia()`、`:201-205 batchAction('move')`;`src/server/albums.ts:360-395 relocateExtFile()`。

**核对结果**:属实。`service.ts:178` 先 `db.update(media).set(set)`,再 `:180 await relocateExtFile(row, set.albumId)`;`batchAction` 同样先 `:201 db.update`,再 `:204` 循环 `relocateExtFile`。`relocateExtFile` 失败时(`albums.ts:385`、`:391`)只 `console.error` 然后 `return`,**调用方完全不知道失败**。

**问题**:库里记录属于目标相册,文件却还在原目录。下一次扫描目标相册时,该记录的 `storage_key` 不在目标目录 → 进 `gone` → **记录被删**;同时源相册扫描会把同一文件当新文件重新入库(新 id、备注丢失)。只读挂载、权限不足、跨设备失败都会触发。

**建议**:
- **先移动文件,成功后再改库**(或放在同一"补偿事务"里,失败则回滚)。失败要把错误返回给用户(`409`/`500` + 原因)。
- `batch move` 返回**逐项结果**(成功/失败/原因),而不是只给 `affected: ids.length`。
- ⚠️ 原始 issue 说"`rename` 会静默覆盖同名文件"——**不准确**,见 §10.1。真实问题是 TOCTOU 窗口与失败被吞。
- 其他情况下"目标不是挂载目录"时直接 `return`(只改归属),会造成"库里的归属"与"磁盘目录"不一致。要么禁止,要么明确标注。

### 🟠 2.3 变更检测只看文件大小【已核对属实】

> ✅ **已解决(2026-11-23)** —— 新增 pgs_media.mtime_ms,变更检测改用 (size, mtime);扫描时把「消失」与「新增」按 (size, mtime) 一对一配对,命中则只更新 storage_key/filename,备注与外链 id 不再丢失。

**位置**:`albums.ts:507` 附近 `old.size !== f.size`。

图片被编辑、被同尺寸覆盖(改几个像素、EXIF 被改写、视频被重新封装为相同大小)时不会被发现,缩略图和元数据保持旧的。同时重命名/移动文件在扫描里表现为"一个消失 + 一个新增",**备注、手动封面、外链 id 全部丢失**。

**建议**:
- 表里存 `mtime_ms`(和可选的 `inode`),变更检测用 `(size, mtime)`。
- 重命名检测:`gone` 与 `fresh` 之间按 `(size, mtime, hash 前 64KB)` 或 `inode` 配对,命中就 `UPDATE storage_key` 而不是删除+新建。
- 为 ext 文件也计算 `hash`(现在只有上传的有 hash,见 §6.5),才能做重复检测与重命名检测。

### 🟠 2.4 "删除"的非原子性【已核对属实】

> ✅ **已解决(2026-11-23)** —— 「写黑名单 + 删记录」放进同一事务;物理删除移到事务提交之后,失败会记录并返回给调用者,不再静默继续。

**位置**:`albums.ts:327-353 deleteMediaByIds()`。

**核对结果**:属实。顺序是:写黑名单(`:338`)→ 物理删除源文件(`:341-347`,失败仅 `console.error` 后继续)→ `removeDerived`(`:348`)→ 最后 `DELETE FROM pgs_media`(`:350`)。

其中任何一步中途失败(进程被杀、磁盘错误):
- 文件已删、记录还在 → 列表里出现点开后 404 的"死图"。
- `driver.remove` 抛异常只是 `console.error`,**仍然继续删库记录** → 留下孤儿文件且无记录可追踪。
- `block` 与记录删除不在同一事务里。

**建议**:把"写黑名单 + 删记录"放进一个事务;物理删除放在事务提交之后,失败时记录到 `pending_deletes` 表由后台重试,或至少把失败路径返回给调用者。

### 🟠 2.5 解除黑名单会换 id【已核对属实】

> ✅ **已解决(2026-11-23)** —— 解除黑名单优先复用原 media_id(冲突时才换新 id),/f/<id> 外链在删除→反悔后仍然有效。

**位置**:`src/server/blocklist.ts:111` `const newId = randomId(12);`

恢复时用新 id,但黑名单里保存了原来的 `media_id`。**之前贴出去的 `/f/<id>` 外链在"删除→反悔"后永远失效**。既然已保存 `mediaId`,恢复时应直接复用(除非冲突)。

---

### 🟠 2.6 删除受管相册 `media=move` 时,文件并没有搬【已核对属实】

> ✅ **已解决(2026-11-23)** —— 删除受管相册 media=move 时真正把文件搬到父相册目录(或 _inbox)并更新 storage_key;搬失败保持原归属并记录日志。

**位置**:`albums.ts:413-425 deleteAlbum()`。

**核对结果**:属实。`albums.ts:420` 只 `db.update(media).set({ albumId: parent })`,文件仍留在 `albums/<已删除相册code>/` 目录里;`:424` `fs.rmdir(...).catch(() => undefined)` 因目录非空而静默失败。长期下来磁盘目录结构与数据库归属脱节,且那个目录**永远不会被清理**。

同理,把受管相册的媒体 `PATCH {album}` 移到另一个受管相册时,本地文件也不会移动(`relocateExtFile` 只处理 `ext`)。

**建议**:统一一个"相册→存储前缀"的映射策略:
- 要么文件路径不再和相册 code 绑定(例如按 `id` 前两位分片存放,像 `derived/` 那样);
- 要么移动时真正搬文件。

**前者更简单,且一次性消除所有搬迁问题**。但注意:改成按 id 分片是**破坏性变更**,需要对已有 `storage_key` 做迁移(见 §5.3),成本比原始 issue 估计的高。

### 🟠 2.7 上传/导入失败的"垃圾"【已核对属实】

> ✅ **已解决(2026-11-23)** —— processMedia 因记录已删除而提前返回时会清理 localHints 条目与临时副本;队列新增最多 3 次指数退避重试(1s/4s/16s)。moveFile 半文件清理与魔数校验仍未做。

- `processMedia` 失败的文件(`status=failed`)本体保留在磁盘上,没有自动清理或重试策略。`reprocessFailed` 只能手动点。建议:自动指数退避重试(如 3 次),并区分"永久失败(格式损坏)"与"临时失败(OOM、ffmpeg 超时)"。
- `moveFile` 的 EXDEV 回退(pipeline 复制)失败时会在目标留下**半个文件**,没有清理,`uniqueKey` 之后会把这个半文件当"已存在"。应写到 `dst.tmp` 再 `rename`。
- `derive.ts` 的 `localHints` Map:当 `processMedia` 因记录已被删除而提前 `return` 时,不删除对应条目,**临时文件和 Map 条目一起泄漏**(直到 6 小时后 `cleanTmp` 清文件,Map 条目永远不清)。
- 文件类型**只按扩展名**判断(`detectKind`)。伪装成 `.jpg` 的任意文件会被收下并以 `image/jpeg` 提供(有 `nosniff`,浏览器端风险不大,但占空间、让流水线反复失败)。建议用 `sharp.metadata()` / `file-type` 魔数校验,不通过直接拒绝。

### 🟠 2.8 `import` 是同步长请求【已核对属实】

> ⏳ **本次未处理** —— POST /media/import 仍是同步长请求,未改成 Job 异步任务。

**位置**:`api/media.ts` `POST /media/import`。

最多 20000 个文件在一个 HTTP 请求里复制完才返回。反代超时(Nginx 默认 60s)、浏览器/CLI 超时都会导致"请求断了但服务端还在复制",客户端既不知道进度也无法取消。**建议做成异步任务**:`POST /jobs/import` 返回 `jobId`,`GET /jobs/:id` 查进度(已处理/失败/总数),支持取消。扫描、重新生成缩略图也用同一套 Job 接口。

### 🟡 2.9 其它【已核对属实】

> ✅ **已解决(2026-11-23)** —— 启动恢复 pending 改为按创建时间倒序取最近 20000 条并打印警告;队列 waiting 用游标 head 代替 shift(),消除大数组 O(n) 移动。数据库驱动队列仍未做。

- 任务队列、扫描状态、HD 缓存索引都在内存里,**进程重启即丢**。恢复靠"pending 记录重新入队",且只恢复 5 万条(`ready.ts:30` `.limit(50_000)`):**超过 5 万条 pending 时,剩下的永远不会被处理**(除非手动点"重新处理")。见 §6.6 的 DB 队列方案。
- `failed` 的任务不会重试,`queue.ts` 的 `.catch(() => state.failed++)` 把错误对象吞掉了,只有计数没有原因(原因其实写进了数据库 `error` 字段,但队列层面不可见)。
- 多实例部署会出问题:队列、限流、`tree` 缓存、`scanStates` 都是进程内状态(`project.md` §14 已说明)。若不打算支持多实例,最好在文档/启动日志明确写"仅支持单实例",并在数据库用 advisory lock 做**单例保护**(第二个实例启动直接退出),避免有人误开两个容器导致重复扫描、重复处理。

---

## 3. API 设计

### 🟠 3.1 响应与状态码约定不一致【已核对属实】

> ✅ **已解决(2026-11-23)** —— /media/upload 全部失败时返回 ok:false + 422;路由 decodeURIComponent 失败返回 400;每个请求生成 X-Request-Id 并写入错误响应与日志;/api/health 改为纯 liveness,新增 /api/v1/health/ready 做数据库/目录/磁盘检查。

- `POST /media/upload` 在全部失败时返回 **HTTP 422 但 body 里仍是 `{"ok":true,...}`**(`api/media.ts:92-93`)。客户端按 `ok` 判断就会误以为成功。要么返回 `ok:false` + `error`,要么统一用 `207 Multi-Status` 并在每个 `results[i]` 标 `ok`。
- ⚠️ 原始 issue 说"`/health` 与 `/api/health` 两套格式"——**需修正**,见 §10.6。实际是 `/api/v1/health`(`admin.ts:109`,返回 `{status:"ok",version}`)与 `/api/health`(`src/app/api/health/route.ts`,返回 `{ok:true}`)两套。建议保留一个,另一个当别名。同时区分 **liveness**(进程活着)与 **readiness**(数据库连通、已完成 `ensureReady`、DATA_DIR 可写、磁盘剩余空间)。现在两者都只做 `select 1`。
- 路径参数 `decodeURIComponent` 在 `router.ts:40 match()` 里没有 try/catch,格式错误的 `%` 会抛 `URIError`,被当成 **500 internal_error** 并打印错误日志。应返回 400。
- 错误里没有 `requestId`,排查只能靠时间戳。建议每个请求生成 `X-Request-Id` 并在错误响应、日志中带上。

### 🟠 3.2 列表接口缺少分页/上限【已核对属实】

> ⏳ **本次未处理** —— 列表接口仍未统一分页/上限(/albums、/users、/keys、/blocklist 一次返回全部);/media 未加 total 与更多过滤。

`GET /albums`、`/users`、`/keys`、`/blocklist`(会 JOIN 全部相册)、`/security/events` 都是**一次返回全部**。挂载一个有几万个子目录的 NAS 后,`/albums` 响应会很大,`albumDtos` 还要对每个相册做 `scopeIds(…, recursive=true)`(O(n×子树大小))。建议:
- 统一 `limit/cursor`;`/albums?parent=` 已是分层的,前端默认就该用它;`tree=1` 要限制深度/数量。
- `GET /media` 增加 `total`(可选,`count=1` 才计算),增加 `sort=taken|created|name|size`、`album` 多选、`status` 过滤、`hasNote`、`hasGps` 等。

### 🟡 3.3 认证体系

> ⏳ **本次未处理** —— 个人访问令牌(PAT)与作用域未实现;CLI 目前用 login 换来的 30 天会话令牌。

现在是 **Basic(管理员账号密码)+ Bearer(登录 token)+ Cookie** 三合一。对外脚本只能用"账号密码"或 30 天登录 token,**无法做最小权限**。建议新增 **个人访问令牌(PAT)**:`POST /tokens {name, scopes[], expiresAt}` → 只返回一次明文,库里存哈希(沿用下载密钥的实现);scope 对应现有 `Perm`(如 `upload` 只能上传)。CLI、PicGo、ShareX 这类图床客户端都用 PAT。

- 登录接口支持 `remember=false`(会话 Cookie,关浏览器即失效)。
- 预留 TOTP 两步验证、OIDC 单点登录(见 §7.5)。

### 🟡 3.4 其它 API 细节

> ✅ **已解决(2026-11-23)** —— batch move 返回逐项结果 {id, ok, error};新增 POST /media/exists 批量查 hash 供客户端做幂等同步;upload 支持 wait/waitMs 等待本次上传处理完。

- 把"批量操作"的返回改成**逐项结果**:`{ results: [{id, ok, error?}] }`,而不是 `affected: N`。
- 大量写操作缺**幂等性**:`POST /media/upload` 建议支持 `Idempotency-Key` 或"先 HEAD 查 hash"(`POST /media/exists {hashes[]}`),客户端重试/断点续传就不会产生重复(见 §4.3)。
- 提供 **OpenAPI 3** 描述(可从 `route()` 注册信息自动生成)。`project.md` 里的表格目前是唯一 API 文档,容易与代码漂移。
- 没有 CORS 配置。若想让第三方网页/浏览器扩展调用,需要可配置的 `CORS_ORIGINS`。
- 给 JSON 接口加 `ETag`/`If-None-Match`(`/albums`、`/media-timeline`、`/site` 很适合)。
- `/media-timeline`(public,`api/media.ts:135`)没有缓存,每次请求都全表 `GROUP BY` 并把"可见相册 id"逐个拼成 SQL 参数,见 §6.3。
- 返回码细节:`DELETE` 不存在的资源时有的 404 有的 200;`POST` 创建返回 201 的写法在不同路由不统一。

---

## 4. CLI 设计(`cli/pgs.mjs`)

### 🟠 4.1 参数解析太脆弱

> ✅ **已解决(2026-11-23)** —— CLI 改用 util.parseArgs,未知参数直接报错并给出 usage;支持 --k=v、-- 结束符、-c/-q/-r 短参数、--version。

手写解析器:所有不在 `BOOL` 白名单里的 `--xxx` 都会**吞掉下一个参数当值**。
- 拼错布尔开关(`--publc`)会把后面的位置参数(如相册名)吃掉;
- 值参数写在末尾(`--album` 后没有值)得到 `undefined`,请求照发,**没有报错**;
- `--name=foo` 形式不支持;不支持 `--` 结束符、短参数组合;
- 没有子命令级帮助(`pgs album create --help`)、没有 `--version`。

**建议**:改用 Node 内置 `util.parseArgs`(Node ≥ 18.3,零依赖),对每个子命令声明 schema(类型、是否必填、枚举),未知参数直接报错并给出 usage。

### 🟠 4.2 认证与凭据处理

> ✅ **已解决(2026-11-23)** —— 支持 PGS_TOKEN / --token(Bearer)、--password-stdin、PGS_PASSWORD_FILE;新增 pgs login/logout 把令牌保存到 ~/.config/pgs/credentials.json(0600);http:// 连远程主机时给出明文警告。多 profile 未做。

- 密码走 `--password` 或环境变量:**命令行参数会出现在 `ps` 和 shell 历史里**。建议支持 `PGS_PASSWORD_FILE`、`--password-stdin`、交互式输入(TTY 下无回显提示)。
- **每个请求都带 Basic**,服务端每次都要走 scrypt(靠 `basicCache` 60 秒缓存缓解,见 `auth.ts:143`)。建议 CLI 先 `pgs login`(换 Bearer token / PAT),保存到 `~/.config/pgs/credentials.json`(权限 `0600`),后续用 token。
- 当 `PGS_URL` 是 **`http://` 且非本机/内网地址**时,应警告"密码将以明文发送"。
- 支持多个环境(profile):`pgs --profile prod ...`。

### 🟠 4.3 上传的可靠性

> ✅ **已解决(2026-11-23)** —— fetch 加 AbortSignal.timeout 与 429/5xx/网络错误指数退避重试;上传前流式算 SHA-256 调 /media/exists 跳过已存在文件;新增 --dry-run;collect() 改用 lstat 并对损坏链接/无权限目录只跳过不崩溃;去掉 Node 18 的整文件读入回退,package.json 补 engines: node>=22。

`upload()` 每个文件一个请求,并发 `-c`,已经不错,但缺:
- **失败重试**:对 429/5xx/网络错误做指数退避;`fetch` 没有超时,卡住的连接会让 worker 永远挂着(用 `AbortSignal.timeout`)。
- **跳过已存在**:现在是把整个文件传完,服务端才用 hash 判重。几万张图重跑同步命令等于**全量重传**。建议客户端先算 SHA-256(流式),调用新接口 `POST /media/exists`(批量查 hash),只传缺的。这样 `pgs upload` 就变成幂等同步命令。
- **`--dry-run`**、进度条/百分比与速度、最终汇总列出失败文件、`--json` 机器可读输出(现在 `✓/✗` 是给人看的)、非零退出码(`import` 没有)。
- `collect()` 使用 `statSync`,遇到**损坏的符号链接或没权限的文件会让整个命令崩溃**(未捕获异常)。应 try/catch 并计入"跳过"。
- Node 18 回退路径 `new Blob([fs.readFileSync(f)])` 会把**整个文件读进内存**(`openAsBlob` 需 Node ≥ 19.8)。⚠️ 但注意:README 实际写的是 **Node 22+**(`README.md:62`),`package.json` 无 `engines` 字段。所以真正的修复是**补 `engines` 并去掉 18 回退路径**,而不是"把最低版本提到 20"。
- 扩展名白名单 `EXT` 与服务端 `types.ts` **手工同步**。建议服务端提供 `GET /api/v1/meta/types`,CLI 启动时拉取并缓存。

### 🟡 4.4 命令覆盖度

> ✅ **已解决(2026-11-23)** —— 新增 blocklist list|restore|purge、regenerate-derived、status queue --watch、media list --all/--cursor/--json、media get --links。

README 说"所有操作都能通过命令行完成",但目前缺少:
- `blocklist list|restore|purge`(整套 API 都没对应命令);
- `system regenerate-derived`、`status queue --watch`、`security events`;
- `media list` 只取前 50 条,没有 `--all`/`--cursor` 翻页,也没有 `--json` 管道友好的 NDJSON 输出;
- `media get --links`(直接打印直链/Markdown);
- `password`(改自己密码)、`token`(PAT 管理,见 §3.3)、`export/import`(元数据备份);
- shell 自动补全(`pgs completion bash|zsh`)。

### 🟡 4.5 别的

> ⏳ **本次未处理** —— CLI 未做成可 npm i -g 的独立包(已加 bin 字段,可直接 npm link);import 异步化未做。

- 把 CLI 做成可 `npm i -g` 的小包(`bin` 字段),或在 Docker 镜像里放一个 `pgs` 可执行入口,用户 `docker exec pgs pgs status` 就能用。
- `import` 异步任务化(§2.8)后,CLI 提供 `--wait` 和进度。

---

## 5. 项目服务与部署设计

### 🟠 5.1 Dockerfile / compose【已核对属实】

> ✅ **已解决(2026-11-23)** —— Dockerfile 改用 tini 作 PID 1 + 直接 node 启动 next、非 root(node 用户)、HEALTHCHECK、libjemalloc2 + UV_THREADPOOL_SIZE、MALLOC_ARENA_MAX;compose 固定版本标签、端口默认只绑 127.0.0.1、必填变量用 ${VAR:?} 强制、加 NODE_OPTIONS 堆上限与 healthcheck、照片目录示例改 :ro。standalone 输出未启用。

| 问题 | 位置 | 建议 |
|---|---|---|
| `CMD ["npm","start"]`:npm 作 PID 1,信号经 `sh -c` 中转,`node` 未必收到 SIGTERM,`docker stop` 要等 10 秒被 SIGKILL,进行中的上传/任务被粗暴截断 | `Dockerfile:32` | 用 `node node_modules/next/dist/bin/next start`,或 `output:"standalone"` 后 `node server.js`;加 `tini`/`--init`;在 SIGTERM 里停止接收新请求、等队列 drain(超时放弃)、`pool.end()` |
| 以 **root** 运行,且 compose 示例鼓励读写挂载照片目录 | `Dockerfile`(无 `USER`) | 加 `USER node`(`DATA_DIR` 给好属主),照片目录示例默认 `:ro`(§1.10) |
| 没有 `HEALTHCHECK`,app 服务也没有 compose `healthcheck` | `Dockerfile` / compose | `HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/api/health')..."`;配合 readiness 接口 |
| 没用 Next `output:"standalone"`,镜像里带完整 `node_modules` + `.next` | `next.config.ts` | 开启 standalone,镜像体积通常能降一半以上。sharp/ffmpeg 需 `outputFileTracingIncludes` 或手动复制 |
| `image: ...:latest` + `pull_policy: always` | `docker-compose.yml` | 每次 `up` 都可能被动升级到未经测试的新版本,且数据库无迁移版本号(见 §5.3)。示例应固定到 `v1.2.x`,升级由用户主动改 tag |
| 没有资源限制 | `docker-compose.yml` | 示例加 `mem_limit`、`cpus`,并同时设 `NODE_OPTIONS=--max-old-space-size=…`(否则 V8 按宿主机内存估算堆上限,容器限制更小时会被 OOM Killer 直接杀) |
| 数据库密码、`SESSION_SECRET` 写在 compose 里 | `docker-compose.yml:51` | 改用 `.env` + `env_file`,或 Docker secrets;示例用 `${PGS_SESSION_SECRET:?must set}` 强制必填 |
| 数据库端口没暴露(好),但 `pgdata` 备份没提 | README | 提供备份说明(`pg_dump` + 备份 `DATA_DIR/{albums,branding}`,`derived/` 与 `cache/` 可重建) |
| 构建期用占位 `DATABASE_URL` 骗过 `src/db/index.ts` 的 `throw` | `Dockerfile:15-18` | 让 `db/index.ts` **惰性创建**连接池(第一次用到才读 env 并校验),构建不需要假环境变量 |

### 🟠 5.2 反向代理文档需要补充

> ⏳ **本次未处理** —— README 已补反向代理上传配置与安全清单,但未提供 Caddy/Cloudflare 的完整示例。

README 的 Nginx 示例只覆盖 HD 接口。实际部署最容易踩坑的是:
- **`client_max_body_size`**(Nginx 默认 1MB):不配置的话上传直接 413。
- **`proxy_request_buffering off`**:否则 Nginx 先把整个上传缓冲到磁盘再转发,大文件体验差、占双份磁盘。
- `proxy_read_timeout`/`send_timeout`:同步 `import`、长视频下载、多文件上传容易 504。
- `proxy_buffering off` 用于视频 Range 流。
- 正确传递真实 IP 的写法(§1.2),并说明**不要**使用 `$proxy_add_x_forwarded_for`。
- 若用 Cloudflare 等 CDN:`/api/*`、`/f/*` 缓存规则,以及 100MB 上传限制。

### 🟠 5.3 数据库迁移机制

> ⏳ **本次未处理** —— 未引入 drizzle 迁移文件与 schema_version;仍靠 bootstrap.ts 的 CREATE/ALTER IF NOT EXISTS 幂等升级。未加 FK/CHECK 约束。

**现状**:`schema.ts` 与 `bootstrap.ts` 手写 DDL 两处维护(`project.md` 也写了"必须同步改"),建表靠 `CREATE TABLE IF NOT EXISTS`,字段变更靠将来手写 `ALTER TABLE ... IF NOT EXISTS`。

**问题**:
- 两处定义必然漂移,且没有测试保证一致;
- 没有 `schema_version`,无法做**有顺序的数据迁移**(如回填 `mtime`、拆表、改索引),也不能降级判断("数据库比程序新"时应拒绝启动);
- 没有外键与 CHECK 约束:`pgs_media.album_id` 没有 FK,删除相册靠应用代码保证;`role`/`kind`/`status`/`visibility`/`storage` 都是裸 `text`,拼写错误能直接入库。

**建议**:改用 drizzle 的**迁移文件**(`drizzle-kit generate` 产出 SQL,运行时 `migrate()` 执行,自带迁移版本表)。保留 advisory lock。把 `role/kind/status/...` 加 `CHECK`,`album_id` 加 `REFERENCES pgs_albums(id) ON DELETE SET NULL`(或 `RESTRICT`,视删除策略)。

---

### 🟠 5.4 数据库连接池【已核对属实,一行代码的高价值修复】

> ✅ **已解决(2026-11-23)** —— 连接池无条件缓存到 globalThis;新增 pool.on('error') 监听避免空闲连接出错杀死进程;配置 DB_POOL_MAX / DB_STATEMENT_TIMEOUT_MS / DB_CONNECT_TIMEOUT_MS / DATABASE_SSL 与 application_name;改为惰性创建,构建期不再需要占位 DATABASE_URL。

**位置**:`src/db/index.ts`(全文仅 25 行)。

**核对结果**:属实,两个问题都在:

```ts
export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ?? new Pool({ connectionString: databaseUrl });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;   // ← 生产环境不缓存
}
```

1. **没有 `pool.on('error', ...)`**。`pg` 的空闲客户端出错(数据库重启、网络闪断、`idle_in_transaction` 超时)会触发 `error` 事件,没有监听器会变成**未捕获异常,直接让 Node 进程退出**。这是 `pg` 文档明确提醒的。
2. 连接池实例只在 `NODE_ENV !== "production"` 时缓存到 `globalThis`。生产环境下,若 `instrumentation.ts`、Route Handler、`ready.ts` 被打进**不同 bundle**,可能各自创建一个连接池(各 10 个连接,默认 `max=10`)。
3. 没有设置 `max`、`idleTimeoutMillis`、`connectionTimeoutMillis`、`statement_timeout`、`application_name`。后台并发 15 个任务 + 请求争用 10 个连接,会出现任务把 API 请求"饿住"的情况。建议:`max` 与 `THUMB_CONCURRENCY` 解耦,单独 `DB_POOL_MAX`;给 HTTP 请求设 `statement_timeout`(如 15s);队列任务不应长期占着连接。
4. 与 §5.3 一起:提供 `DATABASE_SSL` 之类选项,连云数据库时需要。

**建议实现**:见附录 A.2。这是全文档中**性价比最高的一处改动**——约 10 行,消除一类进程级崩溃。

### 🟡 5.5 CI / 发布【已核对属实】

> ✅ **已解决(2026-11-23)** —— 新增 .github/workflows/ci.yml 跑 typecheck + lint + build;@types/busboy、@types/heic-convert 移到 devDependencies;package.json 补 engines 与 bin。版本号仍有两处硬编码。

- **CI 没有任何测试/类型检查/lint 步骤**:`docker-publish.yml` 在每次推送 `main` 时直接构建并推 `latest`。`package.json` 里其实**已经有** `lint`(`eslint .`)和 `typecheck`(`tsc --noEmit`)脚本,但 CI 没调用。建议加 PR 工作流:`npm ci && npx next typegen && npm run typecheck && npm run lint && npm run build`。
- 仓库**没有自动化测试**(`scripts/` 下只有 `cleanup-image-versions.py` 和 `test-hd.mjs`)。见 §8。
- 镜像清理策略"只保留最新两个版本",意味着**出问题时最多回滚一个版本**,`v*` 语义化标签也会被清掉。建议至少永久保留所有 `vX.Y.Z` 标签,只清理 `sha-*`。
- Actions 用 tag 引用(`@v4`),建议固定到 commit SHA(并用 Dependabot 更新);加镜像漏洞扫描(Trivy)、SBOM 与签名(cosign)。
- 版本号在 `package.json`(`1.2.0`)与 `config.ts:45`(`version: "1.2.0"`)两处硬编码。建议从 `package.json` 读取,或构建时注入。
- 依赖:`@types/busboy`、`@types/heic-convert` 放在了 `dependencies`(运行时不需要),可移到 `devDependencies`。

### 🟡 5.6 可观测性

> ✅ **已解决(2026-11-23)** —— 安全日志已有 5MB 轮转;/status 增加 5 秒缓存并输出新增并发/隐私配置项。结构化日志与 /metrics 未做。

- 日志只有 `console.error`,没有级别、没有 JSON 格式、没有 requestId。建议接 `pino`,按 `LOG_LEVEL` 输出结构化日志。
- 安全日志 `DATA_DIR/logs/security.log` 一直 `appendFile`,**没有轮转与大小上限**,被刷时会长期增长。
- 没有 `/metrics`(Prometheus):队列长度/耗时、HD 命中率、扫描耗时、DB 连接数、HTTP 延迟分位。`/status`(`admin.ts:119`)里已有大部分数据,输出成 Prometheus 文本格式即可。
- 给每个后台任务(扫描、缩略图、清理)记录耗时与错误;`processMedia` 失败要有可检索的失败原因分类。

---

## 6. 内存、CPU 与 IO 优化

> 先说结论:项目已做了不少正确的事(流式上传、`sharp.cache(false)`(`derive.ts:20`)、缩略图从预览图缩小、游标分页、`ETag`/304)。真正会出问题的是"默认并发太高"与"几处整文件读入内存"。以下按**收益**排序。

### 🟠 6.1 处理任务的内存峰值【已核对属实,但数字需修正】

> ✅ **已解决(2026-11-23)** —— THUMB_CONCURRENCY 默认改为 min(4, CPU);新增 VIDEO_CONCURRENCY(2) 与 HEIC_CONCURRENCY(1) 分池限流;EXIF 改为只读文件头(EXIF_READ_BYTES,默认 1MB,读不到再放大到 8MB);makeDerived 加 limitInputPixels 与 sequentialRead;ffmpeg 抽帧直接 scale 到 1600 以内;Dockerfile 加 jemalloc 与 UV_THREADPOOL_SIZE。S3 预签名直读未做。

**位置**:`config.ts:60` `thumbConcurrency`(默认 15)、`derive.ts`、`metadata.ts:114`。

**核对结果**:属实。`config.ts:60` `int("THUMB_CONCURRENCY", 15, 1, 128)`;`metadata.ts:114` `EXIF_MAX_BYTES = 64 * 1024 * 1024` 且 `:117` `fs.readFile(file)` 全量读入;`derive.ts:21` `sharp.concurrency(2)`。

1. **默认并发 15 太激进**。每个任务可能同时持有:原图解码缓冲、`previewBuf`、`thumbBuf`、EXIF 的 Buffer、ffmpeg 子进程。
   - 一张 100MP 的 JPEG,libvips 缩小加载时通常很省,但 PNG/TIFF/部分 WebP 需完整解码,RGBA 约 400MB;
   - 15 并发碰上一批大图(相机原片、扫描件)就是几个 GB;
   - 每个 sharp 任务内部还有 `sharp.concurrency(2)` 个线程,15×2=30 线程抢 CPU。
   - **建议**:默认值取 `min(4, os.availableParallelism())`(容器里要读 cgroup 的 CPU/内存限制),并按任务类型分池——**图片、视频(ffmpeg)、HEIC 各自一个并发上限**(如图片 4、视频 2、HEIC 1)。
2. **`readExifInput` 把最多 64MB 整个读进内存**(`metadata.ts:114-130`)。EXIF/XMP/IPTC/ICC 都在文件头部,只需读前面一部分。⚠️ 原始 issue 估算"15 × 64MB ≈ 1GB"偏保守,见 §10.4。**建议**:只读文件头 `fs.read` 前 512KB~1MB 传给 `exifr`(exifr 对部分数据解析本身就是设计用法),拿不到再逐步扩大到如 8MB。PNG 文本块、WebP/AVIF/HEIC 的容器元数据同理按需扩展读取。
3. **HEIC**:`heicToJpeg` 先 `readFile` 整个文件,再用纯 JS/WASM 的 `heic-convert` 解码,最后输出 JPEG Buffer;`processMedia` 与 HD(`convert`)两处都会调用。这是**最吃内存/CPU 的路径**。建议:
   - 放进独立的 `limiter(1)` 或 `limiter(2)`;
   - 先查 sharp 预编译包是否带 HEVC 解码(通常没有,因专利),若 libvips 自编译带 libheif+HEVC,优先用 sharp 直接读;
   - 缓存转换结果(同一张图在"派生图""HD""元数据"阶段不要各转一遍)。
4. **`makeDerived` 做了 3 次解码/编码**(`derive.ts:49-57`):原图→`previewBuf`(WebP)→再解码 `previewBuf` 生成 `thumbBuf`→再解码 `thumbBuf` 取平均色(`:57` `sharp(thumbBuf).resize(1,1)`)。可优化为:平均色直接从 `thumbBuf` 的 `stats()` 或 `resize(1,1)` 一次得到(现状已是从 thumbBuf 取,这点 OK),重点是**补 `limitInputPixels`**(`derive.ts` 没设,只有 HD 设了 `maxInputMp`)和 `sequentialRead: true`,防止恶意/超大图(解压炸弹)占满内存。⚠️ 原始 issue 附录 A.6 建议的"从原图 clone 出两张"**会提高内存峰值**,见 §10.3。
5. **视频抽帧**:`grabVideoFrame` 输出**全分辨率 PNG** 到 tmp(4K 视频一帧 PNG 约 10~25MB),然后 sharp 再读回缩小。建议让 ffmpeg 直接 `-vf scale=1600:-2 -f image2 -c:v mjpeg`(或 `libwebp`)输出小图。已有 `-nostdin`;建议补 `-analyzeduration/-probesize` 限制、`nice`/`ionice`(Linux)。ffprobe/ffmpeg 已有 30 秒超时,这点不错,但**超时后子进程要 `kill -9`**(`execFile` 的 `timeout` 默认发 SIGTERM,ffmpeg 偶尔不退出)。
6. **S3 存储的视频处理**:`materialize()` 会把**整个视频下载**到 `DATA_DIR/tmp` 再抽帧/探测。ffmpeg/ffprobe 完全可以直接读**预签名 HTTP URL**(支持 Range),只下载需要的几 MB。
7. **`libuv` 线程池只有 4 个线程**(`UV_THREADPOOL_SIZE` 默认 4),而 scrypt、`fs.*`、`zlib`、sharp(部分调度)共用它。一旦并发处理图片 + 有人登录,**文件读写会排队**。建议在 Dockerfile/启动脚本设 `UV_THREADPOOL_SIZE=8~16`。
8. **glibc 内存碎片**:sharp 官方文档明确提示,Linux(glibc)上长时间运行 + 频繁分配大 Buffer 会导致 RSS 持续上涨看起来像"内存泄漏",推荐用 **jemalloc**(`LD_PRELOAD=libjemalloc.so.2`)或设 `MALLOC_ARENA_MAX=2`。`node:22-bookworm-slim` 默认 glibc,建议镜像里 `apt install libjemalloc2` 并设环境变量,通常能把长期 RSS 降 30%~50%。
9. **`localHints` Map**:见 §2.7,存在小泄漏。

### 🟠 6.2 每个文件请求都 `select *` + 重算游客可见集合【已核对属实】

> ✅ **已解决(2026-11-23)** —— serveMedia 改为只 select 需要的 8 列,不再带出 meta/search_text;游客可见集合随相册树一起缓存(publicIds),不再每次请求重算;派生图 max-age 降到 300 并保留 ETag/304。X-Accel-Redirect 未做。

**位置**:`files.ts:117 serveMedia()`;`media/service.ts` `canSee`;`albums.ts:89-95 visibleIds()`。

**核对结果**:属实。

```ts
// files.ts:117
const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
```

- `serveMedia` 对每次缩略图/预览图请求都 `select()` **整行**,包括 `meta`(jsonb,含 `raw` 各段,可能几十 KB)和 `search_text`(含 AI 提示词)。一个页面 60 张缩略图 = 60 次读取并反序列化大 JSON,实际只需要 `album_id / kind / storage / storage_key / mime / filename` 6 个字段。
- `canSee(albumId, null)`(游客)→ `visibleIds(null)`(`albums.ts:89`)→ **每次都对全部相册重新计算** `effectivelyPublic`(`:94` `t.rows.filter(...)`)并构造新 `Set`。有几千个子相册的 NAS 目录,每个缩略图请求都要做一遍。同一函数在 `listMedia`、`/media/:id` 里也会被反复调用。

**建议**:
- 只选需要的列(见附录 A.3)。
- 把"游客可见集合 `allowed`"和 `tree` 一起缓存(`loadTree` 重建时一并算好),`invalidateAlbums()` 才失效。
- 派生图响应头可**加版本参数并设为 `immutable`**:`/thumb?v=<mtime36>` + `Cache-Control: public, max-age=31536000, immutable`。现在 `files.ts:63` 是 `max-age=86400` 且不带版本,重新生成后需等一天。
- **把文件交给反代发送**:Nginx `X-Accel-Redirect`(或 Caddy `X-Sendfile`)。应用做完鉴权只回一个内部路径,Nginx 用 `sendfile` 直接发,**Node 不再读文件、不占 Buffer、不占事件循环**。对缩略图和原图/视频都适用,是性价比最高的优化之一。

### 🟠 6.3 统计与聚合查询的写放大【已核对属实】

> ✅ **已解决(2026-11-23)** —— invalidateAlbums 拆出 invalidateMediaCaches() 做 2 秒防抖,入库路径改用它;loadTree/loadStats 增加 in-flight 合并避免惊群;/status 增加 5 秒缓存;统计查询排除 missing_at 记录。

1. **`invalidateAlbums()` 过于频繁**:`ingest.ts:61` 与 `:187` 每成功一个文件就调用一次(另外 `albums.ts` 内还有 7 处),它会清空 `tree` 和 `stats`。批量上传/扫描期间,**任何一个列表请求都会触发 `loadTree()`(全相册 SELECT)和 `loadStats()`(`pgs_media` 全表 `GROUP BY` + `DISTINCT ON`)**,且缓存失效瞬间多个并发请求会**同时**重算("惊群",没有 in-flight Promise 去重)。
   - 建议:失效改成**防抖**(最多每 2~5 秒真正失效一次);给 `loadTree/loadStats` 加 `inflight` Promise 复用;或把统计改成**计数器表**(`pgs_album_counts`,写入时 `+1/-1`)。
2. `loadStats` 的 `DISTINCT ON (album_id) ... ORDER BY album_id, sort_at DESC`:已有索引 `(album_id, sort_at, id)` 能用,但要过滤 `status='ready'` 会降低索引效率。可做部分索引 `... WHERE status='ready'`。
3. **`/status` 与系统页每 3 秒轮询**(`SystemTab`):含 `count(*) FILTER (...)` 全表聚合。百万级媒体后,每开一个管理员页面就是每 3 秒一次全表扫描。建议:缓存 5~10 秒;或用 `pg_class.reltuples` 做近似值;精确计数异步刷新。
4. `unsortedCount()`:每次 `GET /albums`(登录用户)都 `count(*) WHERE album_id IS NULL`,没有缓存。
5. **`/media-timeline`**(public):没有缓存;且游客时 `album_id IN (...)` 是把每个可见相册 id 拼成 SQL 字面参数(`service.ts:73` `inArray(media.albumId, [...allowed])`)。PostgreSQL 一条语句最多 **65535 个绑定参数**,游客可见相册数接近或超过这个数(挂载很深的图库)就会报错;`listMedia` 同理。**建议**:把可见性下推成 SQL 条件,例如给 `pgs_albums` 增加物化字段 `effective_public`(写相册时维护),查询用 `JOIN pgs_albums a ON a.id = m.album_id WHERE a.effective_public`,或使用 `= ANY($1::text[])` 传一个数组参数(单参数)。

---

### 🟠 6.4 搜索性能【已核对属实】

> ✅ **已解决(2026-11-23)** —— bootstrap 自动 CREATE EXTENSION pg_trgm 并建 GIN(search_text gin_trgm_ops) 索引(失败只告警);status 索引改为只索引未完成记录的部分索引;匿名搜索加 IP 限流(SEARCH_RATE_PER_MIN)。

**位置**:`src/server/media/service.ts:80`

```ts
for (const term of terms) conds.push(like(media.searchText, `%${term.replace(/[\\%_]/g, "\\$&")}%`));
```

`LIKE '%x%'` 没法用 B-tree 索引,**每次搜索都是顺序扫描整张 `pgs_media`**(且 `search_text` 含 AI 提示词,行很宽)。`/media` 是 `public`(`api/media.ts:18`)、无限流,所以也是便宜的 DoS 入口。

**建议**:
- 开启 `pg_trgm`:`CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE INDEX ... ON pgs_media USING gin (search_text gin_trgm_ops);`,`LIKE '%x%'` 就能走 GIN。(官方 `postgres:16-alpine` 镜像自带 contrib。)
- 或改 `tsvector` 全文搜索(中文需分词方案如 `zhparser`/`pg_jieba`,部署成本较高;trigram 对中文子串匹配反而更直接)。
- 把 `search_text`(大文本)与主表拆开,避免 `select *` 时被带出(§6.2 已建议只选必要列)。
- 对匿名搜索加限流(IP 维度每分钟 N 次),并限制词数/词长。
- 给 `status` 建**部分索引**:`CREATE INDEX ... ON pgs_media(id) WHERE status <> 'ready'`。现在的全量 `status` 索引基数极低(几乎都是 `ready`),几乎没用且拖慢写入。

### 🟠 6.5 hash / 重复检测【已核对属实】

> ⏳ **本次未处理** —— 挂载目录(ext)入库时仍未计算 hash,重复检测与感知哈希未做;判重的 IS NOT DISTINCT FROM 未改写。

- 只有**上传**的文件才计算 `sha256`(`ingest.ts:167` `hash: file.hash`);挂载目录(`ext`)入库时没有 hash(`albums.ts:505` 的 insert 无 `hash`),所以挂载目录里的重复图完全检测不到,`pgs_media_hash_idx` 对它们也没用。建议在 `processMedia` 阶段(文件已被读)顺带算 hash 回填,或先算"前 64KB + 尾 64KB + size"的快速指纹。
- 判重条件是 `hash = ? AND album_id IS NOT DISTINCT FROM ?`(`ingest.ts:145`):`IS NOT DISTINCT FROM` 不能走普通索引。拆成 `album_id IS NULL` / `album_id = ?` 两种写法;或建 `(hash, album_id)` 组合索引。
- 图片的近似重复(缩放/压缩后的同一张图)可用感知哈希(dHash/pHash),见 §7.4。

### 🟠 6.6 任务队列【已核对属实】

> ✅ **已解决(2026-11-23)** —— 队列 waiting 改用游标 head,priority 插入 O(1);新增 idleIds() 只等本次上传的 id;失败任务最多 3 次指数退避重试并在 stats 里暴露 retrying。数据库驱动队列未做。

**位置**:`src/server/queue.ts`

**核对结果**:属实。`queue.ts:11-12` `waiting: string[]; queued: Set<string>`;`:31` `state.waiting.shift()!`;`:53` `state.waiting.unshift(id)`。

- 队列在内存里,**扫描一个 100 万张图的目录**时会把 100 万个 id 放进 `waiting` 数组和 `queued` Set(几十到一百多 MB)。
- `waiting.shift()` 在大数组上是 O(n)(V8 对大数组的 `shift` 不是常数时间);`priority` 的 `unshift` 同样。
- `idle(timeoutMs)`(`:70`):上传接口等待的是"**整个队列**清空",并非"本次上传的文件处理完"。扫描在后台跑时,上传永远等满超时才返回。应按"本次上传的 id 集合"等待。
- 重启后只恢复 5 万个 pending(§2.9),且没有重试、没有退避、没有任务优先级(重新处理 vs 新上传 vs 全量重生成)。

**建议**:把队列改成**数据库驱动**(单表即可,不必引入 Redis):`pgs_media.status='pending'` 本身就是队列。Worker 用 `SELECT id FROM pgs_media WHERE status='pending' ORDER BY priority DESC, created_at LIMIT $n FOR UPDATE SKIP LOCKED` **按批领取**,处理完更新状态,内存里不再保存全量 id;失败写 `attempts`、`next_retry_at`,实现指数退避。这样**重启安全、多实例安全、内存恒定**,代码量其实比现在的队列还少。实现见附录 A.5。

### 🟡 6.7 HD 预览链路【已核对属实】

> ✅ **已解决(2026-11-23)** —— HD 响应不再 new Uint8Array(out) 复制一份;水印层缓存变体上限 24 并按 LRU 淘汰。水印结果缓存与 X-Accel 未做。

**位置**:`src/server/hd/service.ts`、`hd/cache.ts`、`hd/watermark.ts`。

**核对结果**:属实。`hd/cache.ts:102` `fs.readFile(e.file)` 整张读入;`hd/service.ts:190` `new Response(new Uint8Array(out))` 再复制一份;`hd/service.ts:186` 每次请求都 `gate(() => applyWatermark(...))`。

- `getCached` 用 `fs.readFile` 把整张 HD webp(几百 KB~几 MB)读进内存,响应时再 `new Uint8Array(out)` **复制一份**。并发 3 个转换 + N 个并发读取,内存按"并发数 × 图大小 × 2"增长。可直接 `createReadStream` 流式输出(但水印需 Buffer,见下条)。
- **每次请求都重新合成水印**(解码 WebP → 叠加 PNG 层 → 再编码 WebP,且质量 `+3`),并与转换共用同一个 `gate(concurrency=3)`。热门图片每次请求都做一遍,CPU 浪费大,还有**二次有损编码**的画质损失。
  - 对**游客**(水印只含 host,不含用户码)完全可以**缓存"带水印的最终结果"**,缓存 key 加 `host + 水印配置哈希`;
  - 对登录用户(动态水印)按 `(用户码)` 缓存,或把水印叠加放在转换那一步(原图 → resize → composite → 一次编码),避免二次编码。
- 水印层 `layerCache`(`watermark.ts:57`)的 key 包含 `siteText`(含 Host,见 §1.9),需限制变体数量;`:116` `if (layerCache.size > 12) layerCache.delete(...)` 逐个淘汰,被刷时会持续重建。
- **防盗的覆盖面**:HD 有令牌、限流、异常检测、水印;但无水印的 `thumb`、`preview`(1600px)和 `/f/:id`(默认回预览图,`files.ts:138`)不受这套保护,游客依然可不限速遍历抓取 1600px 无水印图。若防抓取是目标,需给 `preview` 和 `/f/` 也加同样限流/异常检测(至少"遍历大量不同图片"的检测),或承认 1600px 就是公开质量并在文档讲清。
- `security.log` 轮转(§5.6)。

### 🟡 6.8 前端

> ⏳ **本次未处理** —— 前端图库未做虚拟列表;轮询未改 SSE;缩略图未加 width/height 与 fetchpriority。

- `Gallery.tsx` 的 `items` 数组随无限滚动**只增不减**,配合 `content-visibility:auto` 对渲染有帮助,但 DOM 节点和图片解码缓存还是会涨。几千张之后建议**窗口化/虚拟列表**(只保留视口前后若干行节点;`@tanstack/react-virtual` 或自己按行高分段)。
- 处理中项的轮询(每 3 秒请求前 80 项)在没有 pending 时会停,这点不错;若有人上传大批量,可改成 **SSE**(`/api/v1/events`),服务端队列完成时推送。
- 缩略图 `<img>` 可加 `width/height`(已知宽高,避免布局抖动)和 `fetchpriority`;给视频封面和 AI 图增加 ThumbHash/BlurHash 占位(现在用平均色)。
- 查看器的 HD blob URL 有 `revokeObjectURL`,处理规范。

### 🟡 6.9 其它小优化

> ✅ **已解决(2026-11-23)** —— Intl.Collator 实例复用;扫描时对 stat 做 8 路受限并发,并在扫描开始时一次性取黑名单;目录浏览排序复用 collator。

- `loadTree` 每次失效就 `SELECT * FROM pgs_albums` 并 `sort((a,b)=>a.name.localeCompare(b.name,"zh"))`(`albums.ts:44`);相册多时 `localeCompare` 很慢(每次比较创建 collator)。把 `Intl.Collator("zh")` 实例复用。
- `scanOne` 里每个目录都调 `blockedExtKeys()`(5 秒缓存,长扫描里会反复过期)且**每个文件一次 `fs.stat`、串行**。在 NAS(网络文件系统)上这是最慢的部分。可以:对 `stat` 做受限并发(8~16);扫描开始时一次性取 blocklist;目录 `mtime` 没变就跳过整个目录。
- 定时全量扫描(`SCAN_INTERVAL_MIN`)对大库代价很高。可用 `chokidar`/`fs.watch`(Linux inotify 有 watch 数量上限,需降级策略)做增量,定时扫描降频兜底。
- 响应压缩:JSON 列表接口可由反代做 gzip/br;确保图片(已压缩)不要再压缩。

---

## 7. 可以扩展的功能(🟢 Idea)

按"与现有架构的契合度 × 用户价值"排序。

### 7.1 分享链接(强烈推荐,替代全局下载密钥)
- 针对**相册 / 单个媒体 / 多选集合**生成分享链接 `/s/<token>`;可选:过期时间、密码、下载次数上限、是否允许下载原图、是否显示 EXIF/GPS、访问统计(次数、最近 IP)。
- 支持"打包下载"(ZIP 流式,不落盘)。
- 这能把 §1.5 的"万能密钥"问题一次解决,也更符合用户心智("发给朋友一个链接")。

### 7.2 个人访问令牌 + 作用域
见 §3.3。同时可做**图床兼容接口**:兼容 PicGo/uPic/ShareX 的自定义上传(一个 `POST /upload` 返回 `{url}`),因为已有 `/f/:id` 直链、HTML/Markdown 模板,这个项目天然适合当个人图床。

### 7.3 转码与流媒体
- 视频:生成 720p H.264 预览/HLS 分片(后台队列,ffmpeg `-preset veryfast`),游客和移动端播放它,原视频仅 key/特权用户可取。节省流量、解决浏览器不支持的编码(HEVC/MKV),也是 §1.6 的最佳修复。
- 视频缩略图精灵图(hover 预览/拖动进度条预览)。
- 动图(GIF/WebP/APNG)保持动画的预览。
- 图片按浏览器 `Accept` 协商 AVIF/WebP,按设备像素比输出 `srcset`。

### 7.4 组织与检索
- **标签、收藏、星级、颜色标记**;批量打标签;"智能相册"(保存的搜索条件,如 `kind=video AND year=2024 AND tag=旅行`)。
- **按 EXIF 过滤**:相机、镜头、焦段、ISO、日期范围、有无 GPS、AI 工具/模型(已解析 AI 参数,这块很有差异化——可做"按 prompt/模型/采样器过滤"、"一键复制 prompt"、"以此参数再生成"(导出到 ComfyUI/A1111 的 JSON))。
- **地图视图**(基于 GPS,Leaflet + 瓦片;游客可见性受 §1.7 控制),反向地理编码(离线 `geonames` 或自选服务)。
- **时间线/回忆**:`/media-timeline` 已有雏形。
- **相似/重复图查找**:感知哈希(dHash/pHash)+ 汉明距离;提供"重复清理向导"(保留最大/最早的一张,其余进黑名单)。
- 语义搜索:本地 CLIP(ONNX Runtime)生成向量 + `pgvector`,支持"以文搜图""以图搜图";人脸聚类(可选,默认关,注意隐私与许可证)。
- 相册/媒体的多语言名称、描述支持 Markdown。

### 7.5 权限与账号
- **相册级权限**(ACL):某用户只能看/传某些相册,而不是现在"登录即看全部私有相册 + `uploader` 可往任意相册传"。
- 相册密码保护(无需账号的访客凭密码进入)。
- 用户**存储配额**、**上传审核**(uploader 上传进"待审",manager 通过后才公开)。
- TOTP 两步验证;OIDC/OAuth2 登录(接 GitHub/Google/Authentik/Keycloak);**登录设备列表**。
- 操作**审计日志**(谁在何时删除/公开/创建密钥),可在设置页查看和导出。

### 7.6 存储与同步
- S3:**预签名 URL 重定向**(下载原图、视频流直接走对象存储/CDN,不经 Node);S3 上的 HD/派生图也可放对象存储。
- 支持 **WebDAV 服务端**(让手机相册类 App 同步上传)和/或 **Syncthing/rsync 友好**的目录结构;**手机端自动备份**(PWA 做不到后台上传,可兼容现有 App 的 WebDAV/S3 目标)。
- 目录**监听**自动入库(§6.9)。
- **回收站**:删除 → 先进回收站(保留 N 天,到期自动清理),取代"排除名单+purge"的二元模型。现有黑名单可作为回收站的一种状态。
- RAW 支持(`.cr2/.nef/.arw/.dng`:用 `dcraw`/`libraw` 提取内嵌 JPEG 预览,元数据用 `exifr`);Live Photo / Motion Photo 配对。
- 导出/导入**元数据备份**(备注、标签、相册结构、黑名单)为 JSON/NDJSON,迁移服务器时不丢"数据库里的那部分"。

### 7.7 运维与集成
- **Webhook / 事件**:新媒体入库、处理失败、扫描完成、密钥被使用 → 推送到自定义 URL/Telegram/邮件。
- Prometheus `/metrics`、结构化日志、`/api/v1/openapi.json` + 内置 Swagger UI。
- **管理端"任务中心"**:统一展示扫描/导入/重新生成/转码任务,可取消、可重试(§2.8)。
- 设置页"站点设置"支持导出/导入 JSON;**主题分享**。
- i18n 完整化(已有 `DevI18n`,可抽成 `en/zh` 两套资源),README 提供英文版。
- 嵌入/OEmbed:分享页带 OpenGraph/Twitter Card(缩略图 + 标题),分享到社交软件时有预览卡片。
- RSS/Atom:公开相册的订阅源。

---

## 8. 测试与工程化

- 现在**几乎没有自动化测试**。这个项目的"核心承诺"(游客只能看到有效公开相册、无 key 不返回原图、删除可反悔)都是**授权/可见性逻辑**,最需要回归测试。建议用 `vitest` + 一个临时 PostgreSQL(testcontainers 或 CI service)至少覆盖:
  1. 可见性矩阵:游客/各角色 × 公开/私有/祖先私有/未归类 × `thumb/preview/file/stream/hd`;
  2. 下载密钥:无 key / 有效 / 过期 / 无效 / Range;
  3. 扫描:新增/删除/重命名/空目录熔断(§2.1)/黑名单跳过;
  4. 移动 ext 文件的失败回滚(§2.2);
  5. 登录限流含 Basic 路径(§1.1);
  6. 路由权限表:遍历 `routes`,断言每个路由的 `access` 与文档一致(防止新增接口忘写权限,**默认值应该是拒绝而不是 `public`**)。当前 14 个 public 路由见 §0.4 核对记录。
- 把 `project.md` §8 的 API 表格**从路由注册信息自动生成**(或生成 OpenAPI),并在 CI 里检查是否有差异。
- `bootstrap.ts` 与 `schema.ts` 一致性测试(§5.3 改迁移后就没这个问题了)。
- ESLint 里关闭了 `react-hooks/set-state-in-effect`,可以逐步清理而不是全局关闭。
- 加 `.editorconfig`、`prettier`、`husky/lint-staged`(可选)。
- `scripts/test-hd.mjs` 是个很好的起点,可接入 CI 当冒烟测试。
- 加 `SECURITY.md`(漏洞报告渠道)和 `CHANGELOG.md`(尤其破坏性变更与升级步骤,因为没有迁移版本号,更需要写清楚)。

---

## 9. 文档建议

- README "部署"部分增加一节 **"上线前安全清单"**:改管理员密码、设 `SESSION_SECRET`、`COOKIE_SECURE`、`PUBLIC_BASE_URL`、限制 `ALLOWED_MOUNT_ROOTS`、照片目录 `:ro`、反代真实 IP、HTTPS、备份。
- 说明**单实例限制**(§2.9),以及哪些数据可以丢(`derived/`、`cache/`)、哪些不能丢(数据库、`albums/`、`branding/`)。
- 说明一个重要行为:**挂载目录里被符号链接指向的目录/文件不会被扫描**(扫描使用 `Dirent.isDirectory()`,不跟随符号链接)。群晖/NAS 用户经常碰到。
- 说明 `purge` 与黑名单的区别对受管相册(`local`)的含义:未勾选"同时删除原文件"时,受管相册的文件会**留在 `DATA_DIR/albums/...` 里变成无人引用的孤儿**,只能通过黑名单页面恢复或清理。
- 给出**资源建议表**:内存/CPU 与 `THUMB_CONCURRENCY`、`HD_CONCURRENCY`、`HD_CACHE_MAX_MB` 的推荐组合(如 1C1G / 2C4G / 8C16G)。
- 补 `robots.txt` 与 `X-Robots-Tag` 的说明(§11.5)。

---

## 10. 对原始 issue 的修正(动手前必读)

原始 issue 有 6 处需要修正。**如果不先看这一节就照着改,其中 2 处会引入新问题**。

### 10.1 ⚠️ 修正:§2.2 的"`rename` 会静默覆盖同名文件"不成立

原始 issue 称 `relocateExtFile` 里"`stat` 不存在 → `rename`"是 TOCTOU,`rename` 会**静默覆盖**同名文件。

**实际源码**(`albums.ts:374-384`)有一段 **50 次重名规避循环**:

```ts
let dst = path.join(dstDir, base);
for (let i = 0; i < 50; i++) {
  const exists = await fs.stat(dst).catch(() => null);
  if (!exists) break;
  dst = path.join(dstDir, `${stem}-${randomId(4)}${ext}`);
}
```

所以**不存在"静默覆盖"**。真实问题只有两个:
1. **TOCTOU 窗口**:`stat` 与 `rename` 之间若有人并发创建同名文件,`rename` 仍会覆盖它。窗口很窄,但存在。
2. **失败被吞**:`rename`/`copy` 失败只 `console.error` 后 `return`,调用方不知道。

**正确建议**:用 `fs.link()`(硬链接,目标已存在则 `EEXIST` 失败)+ `unlink`,或 `copyFile(..., COPYFILE_EXCL)` 消除 TOCTOU;失败必须向上抛。**不要**按原 issue 的说法去"防止覆盖"——那部分逻辑已经写了。

### 10.2 修正:§5.1 的"npm 不转发 SIGTERM"机制描述不精确

`npm start` 实际会转发信号给 `sh -c`,问题出在 **`sh` 不保证转发给 `node`**。结论(应直接用 `node` 或 `tini`)是对的,但"npm 不转发"这个说法会让你排查错方向。

### 10.3 ⚠️ 修正:附录 A.6 的 sharp 管线建议与现有设计冲突

原始 issue 正文强调"内存峰值",但附录 A.6 建议:

```ts
const [previewBuf, thumbBuf] = await Promise.all([
  img.clone().resize(...).webp(...).toBuffer(),
  img.clone().resize(...).webp(...).toBuffer(),
]);
```

这是从**原图**同时 clone 出两份。而现有 `derive.ts:49-57` 是**从 `previewBuf` 生成 `thumbBuf`**,正是为了"只解码一次大图、后续都在小图上做"。

**按 A.6 改会同时持有两份大图解码缓冲,峰值内存反而更高**,与它自己的论点矛盾。本文档附录 A.6 已按此修正。真正该做的是给输入加 `limitInputPixels` 和 `sequentialRead`。

### 10.4 修正:§6.1 的"约 1GB"估算偏保守

64MB 是 `EXIF_MAX_BYTES` 的**上限**,且超限直接跳过(`metadata.ts:116` `if (!st.isFile() || st.size > EXIF_MAX_BYTES) return null`)。真实场景手机 JPEG 通常 3–8MB,15 并发约 50–120MB。"约 1GB"把最坏情况当常态了。

结论(应只读文件头)成立,但**不要**用"1GB"去说服自己做紧急改造——按 §6.1 第 1 条(降并发)先做,收益更直接。

### 10.5 修正:§1.5 的"低熵密钥可爆破"不是主要风险

`verifyKey` 每次查库、失败无限流——这点属实。但更现实的风险是**未认证的 key 校验请求本身构成放大**:`/f/:id?key=` 是 public,攻击者可用任意 key 高频打,每次一次 DB 查询 + 一次 403。这比"猜中 8 位密钥"容易得多。

**正确优先级**:先给 `invalid_key` 加 IP 限流(挡放大),再考虑提高密钥最小长度(挡爆破)。

### 10.6 修正:§3.1 的"`/health` 与 `/api/health` 两套格式"表述不准

实际是:
- `/api/v1/health`(`admin.ts:109`):`{ status: "ok", version }`
- `/api/health`(`src/app/api/health/route.ts`):`{ ok: true }`

两个都只做 `select 1`。建议保留一个、另一个当别名,并区分 liveness/readiness。

---

## 11. 原始 issue 遗漏的问题(新增)

以下 6 项是核对过程中发现、原始 issue 未提及的。**第 11.1、11.2、11.3 项与 P0 项互相放大,建议合并处理**。

### 🟠 11.1 `basicCache` 无上限、无淘汰【已核对属实】

> ✅ **已解决(2026-11-23)** —— basicCache 加条目上限 1000 与 LRU 淘汰,userCache 上限 2000;仍保留 60 秒成功缓存。

**位置**:`src/server/auth.ts:143`、`:195-203`。

```ts
const basicCache = new Map<string, { id: string; at: number }>();
// ...
const ck = createHash("sha256").update(`${username}\u0000${password}`).digest("hex");
const hit = basicCache.get(ck);
if (hit && Date.now() - hit.at < 60_000) return loadUser(hit.id);
// ... 成功后才 basicCache.set(ck, ...)
```

- 以 `sha256(username+password)` 为 key,**只增不删**(仅 `invalidateUserCache()` 时 `clear()`)。
- 配合 §1.1 的"可无限次尝试 Basic",攻击者用**不同凭据**就能把这个 Map 撑大。比原始 issue 提到的 `fails` Map 更隐蔽,因为它是**成功后才写入**——看起来"无害",但攻击者只要知道**任意一个**有效账号密码,就能用"正确密码 + 不同用户名"或"正确用户名 + 不同密码"反复制造不同 key(前者会失败不写入,后者也失败;真正能撑大的是**多个有效账号**或**密码正确但用户被禁用**的边界情况)。
- 更实际的风险:**无 TTL 清理**,长期运行后即使正常使用也会缓慢增长(每次密码变更产生新 key)。

**建议**:加最大条目数(如 1000)+ LRU 淘汰;或直接用 `expiresAt` 做惰性清理。

### 🟠 11.2 失败路径每次跑两次 scrypt(放大 §1.1 的 DoS)【已核对属实】

> ✅ **已解决(2026-11-23)** —— 时序均衡改为复用同一个随机密码哈希做一次 verifyPassword,失败路径从 2 次 scrypt 降为 1 次。

**位置**:`src/server/auth.ts:197-201`。

```ts
const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
if (!row || row.disabled) {
  await hashPassword("timing-equalizer").catch(() => undefined);   // ← 第 1 次 scrypt
  return null;
}
if (!(await verifyPassword(password, row.passwordHash))) return null;  // ← 第 2 次 scrypt
```

- 用户名不存在时执行 `hashPassword("timing-equalizer")` 做时序均衡,这是**正确的安全实践**(防用户名枚举)。
- 但结果是:**一次失败 = 2 次 scrypt**。配合 §1.1 的无限次 Basic 尝试,线程池 DoS 被放大一倍。

**建议**:时序均衡改用**预计算的固定哈希**做一次 `verifyPassword`(仍是 1 次 scrypt,但可复用常量),而不是每次 `hashPassword` 现算。或者干脆接受"用户名不存在时更快",因为 §1.1 修好后限流已经能挡住枚举。

### 🟠 11.3 游客可用搜索逐字探测管理员备注(侧信道)【已核对属实】

> ✅ **已解决(2026-11-23)** —— buildSearchText 不再拼接 note;listMedia 只在登录用户搜索时才额外匹配 note 列,游客无法再通过搜索探测备注。

**位置**:`src/server/media/metadata.ts:362-373` `buildSearchText()`;`src/server/media/service.ts:80`;`api/media.ts:18`。

```ts
// metadata.ts:363
const parts: string[] = [filename, note];   // ← note 进入 search_text
// service.ts:80
conds.push(like(media.searchText, `%${term}%`));
```

- `buildSearchText` 把 `note` 拼进 `search_text`。
- `GET /media` 是 **public**(`api/media.ts:18`)且支持 `q` 搜索。
- 因此**游客可以用关键词搜索,逐字探测管理员备注内容**。

原始 issue 在 §1.7 只说了"备注直接返回给游客",没意识到还有这条**间接通道**。即使把 `mediaDetail` 的 `note` 字段对游客置空,只要 `search_text` 还含 `note`,侧信道依然存在。

**建议**(三选一,推荐 1+2):
1. `buildSearchText` 不再拼 `note`,或按角色生成两份(游客用不含 note 的版本)。
2. 游客搜索时,在 SQL 层额外排除 note 匹配(需要把 note 单独存一列并只在登录用户搜索时参与)。
3. 给公开搜索加限流(§6.4 已提),把逐字探测的成本抬高。

### 🟡 11.4 `mediaDetail` 把 `error` 字段也返回给游客(可能泄露服务器路径)【已核对属实】

> ✅ **已解决(2026-11-23)** —— mediaDetail 对游客把 error 置空(登录用户仍可见完整信息),避免泄露服务器路径。

**位置**:`src/server/media/service.ts:135` `error: row.error`。

处理失败的错误信息里可能含**服务器绝对路径**——`relocateExtFile` 的 `console.error`(`albums.ts:385`)就打印了 `src`/`dst` 绝对路径,而这类错误文本若被写进 `media.error`,就会通过 public 接口泄露目录结构。

**建议**:游客侧把 `error` 置空(或只返回错误码不含路径);登录用户可见完整信息。

### 🟠 11.5 没有 `robots.txt` / 派生图无 `X-Robots-Tag`,公开相册会被搜索引擎索引【已核对属实】

> ✅ **已解决(2026-11-23)** —— 新增 public/robots.txt(默认 Disallow: /);serveDerived/serveOriginal 与 next.config 的 /api/v1/media/*、/f/* 都加了 X-Robots-Tag: noindex, noimageindex;/f/* 加 Referrer-Policy: no-referrer。

**核对结果**:`public/` 下只有 `offline.html` 和 `sw.js`,**没有 `robots.txt`**。`X-Robots-Tag` 只在 HD 接口设置(`hd/service.ts:200`),`serveDerived`(`files.ts:56-64`)与 `serveOriginal` 都**没有**。

对一个"自托管私密相册"来说,这是比 GPS 泄露更直接的曝光渠道:公开相册的缩略图、预览图会被搜索引擎完整抓取并索引。

**建议**:
1. 加 `public/robots.txt`,默认 `Disallow: /`(自托管相册不需要被索引);若用户想公开可索引,给站点设置开关动态生成。
2. 给 `serveDerived` / `serveOriginal` 加 `X-Robots-Tag: noindex, noimageindex`(与 HD 接口一致)。
3. 给 `/f/*`、`/api/v1/media/*` 加 `Referrer-Policy: no-referrer`(与 §1.5 第 1 条合并做)。

### 🟡 11.6 `serveDerived` 已有 `ETag`/304,原始 issue 未提及(属正面项,但可再优化)【已核对属实】

> ✅ **已解决(2026-11-23)** —— 派生图 max-age 从 86400 降到 300,保留 ETag/304,内容变化后 5 分钟内即失效,无需前端配合。

**位置**:`files.ts:56-70`。

```ts
const etag = `"${id}-${variant}-${st.mtimeMs.toString(36)}-${st.size}"`;
if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
```

这点做得**比原始 issue 描述的好**——它说"派生图不带版本、重新生成后需等一天",实际上 `ETag` 已含 `mtime`,内容变化会立即失效。真正的缺口是 `max-age=86400` 期间浏览器**不会回源校验**,所以 `ETag` 在 `max-age` 内不生效。

**建议**:把 `max-age` 降到 `300`(5 分钟)+ 保留 `ETag`,或改成 `max-age=31536000, immutable` 并给 URL 加 `?v=<mtime36>` 版本参数(需要前端配合改 URL)。**前者改动小、无需前端配合,推荐先做前者**。

---

## 附录 A:可直接参考的实现思路(伪代码/片段)

### A.1 `TRUST_PROXY` 与客户端 IP

```ts
// config.ts
trustProxy: process.env.TRUST_PROXY?.trim() || "0", // "0" | "1" | "2" | "<CIDR,...>"

// router.ts
export function clientIp(req: Request): string {
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const n = Number(config.trustProxy);
  if (Number.isInteger(n) && n > 0 && hops.length >= n) return hops[hops.length - n]; // 信任 n 层代理,取"倒数第 n 个"
  return req.headers.get("x-real-ip")?.trim() || "unknown"; // 反代必须覆盖(而不是追加)此头
}
```

> 注意:Next.js 的 Route Handler 拿不到 socket 地址,所以 `TRUST_PROXY=0` 时只能回落到 `X-Real-IP`(由反代覆盖)。文档里必须写清"不配反代时,限流依赖 `X-Real-IP` 不可伪造"。

### A.2 `pg.Pool` 的健壮配置

```ts
const g = globalThis as typeof globalThis & { __pgsPool?: Pool };
export const pool = (g.__pgsPool ??= (() => {
  const p = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 20_000,           // 防止单条慢查询占住连接
    application_name: "picgalleryserver",
  });
  p.on("error", (e) => console.error("[pg] idle client error", e)); // 否则会 uncaughtException
  return p;
})());
```

### A.3 只选需要的列(文件输出路径)

```ts
const FILE_COLS = {
  id: media.id, albumId: media.albumId, kind: media.kind, mime: media.mime,
  filename: media.filename, storage: media.storage, storageKey: media.storageKey,
};
const [row] = await db.select(FILE_COLS).from(media).where(eq(media.id, id)).limit(1);
```

### A.4 trigram 搜索索引

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS pgs_media_search_trgm
  ON pgs_media USING gin (search_text gin_trgm_ops);
-- 低基数索引改为部分索引
DROP INDEX IF EXISTS pgs_media_status_idx;
CREATE INDEX IF NOT EXISTS pgs_media_todo_idx ON pgs_media (id) WHERE status <> 'ready';
```

### A.5 数据库驱动的任务领取(替代内存队列)

```sql
-- 领取一批任务(多 worker/多实例安全)
UPDATE pgs_media SET status = 'processing', locked_at = now(), attempts = attempts + 1
WHERE id IN (
  SELECT id FROM pgs_media
  WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= now())
  ORDER BY priority DESC, created_at
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
RETURNING id;
-- 启动时:把 locked_at 太久的 'processing' 重置回 'pending'(崩溃恢复)
```

### A.6 一条 sharp 管线出两张图(⚠️ 需按 §10.3 修正后使用)

```ts
// 注意:不要从原图 clone 两次(会同时持有两份大图解码缓冲)。
// 现有 derive.ts 的做法(原图→preview→thumb)在内存上更优,保留即可。
// 真正该加的是输入保护:
const img = sharp(input, {
  failOn: "none",
  limitInputPixels: 268_000_000,   // 防解压炸弹
  sequentialRead: true,
}).rotate();

const previewBuf = await img.clone()
  .resize({ width: PW, height: PW, fit: "inside", withoutEnlargement: true })
  .webp({ quality: 84 }).toBuffer();

// thumb 从 previewBuf 生成(小图,内存友好),平均色从 thumbBuf 一次得到
const thumbBuf = await sharp(previewBuf)
  .resize({ width: TW, height: TW * 2, fit: "inside", withoutEnlargement: true })
  .webp({ quality: 82 }).toBuffer();

const { dominant } = await sharp(thumbBuf).stats();   // 不需要再单独 decode preview
```

### A.7 扫描熔断

```ts
const gone = existing.filter(r => !seen.has(r.key));
const ratio = existing.length ? gone.length / existing.length : 0;
if (existing.length >= 20 && ratio > 0.3) {
  s.error = `检测到 ${gone.length}/${existing.length} 个文件消失(${(ratio*100).toFixed(0)}%),已中止清理。` +
            `如确属预期,请带 --force-prune 重新扫描。`;
  return; // 不删除任何记录
}
```

### A.8 Nginx 上传相关配置

```nginx
client_max_body_size 0;            # 或一个足够大的值,如 20g
location /api/v1/media/upload {
    proxy_pass http://127.0.0.1:3000;
    proxy_request_buffering off;   # 流式转发,不先落盘
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_set_header X-Real-IP $remote_addr;   # 覆盖而不是追加
    proxy_set_header Host $host;
}
# 缩略图/文件:由 Node 鉴权后 X-Accel-Redirect 到 internal 目录,由 Nginx sendfile
location /_protected/derived/ { internal; alias /app/data/derived/; }
```

### A.9 Dockerfile 要点

```dockerfile
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data \
    UV_THREADPOOL_SIZE=12 MALLOC_ARENA_MAX=2
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libjemalloc2 tini \
 && rm -rf /var/lib/apt/lists/*
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2   # arm64 路径不同,可用 ENTRYPOINT 脚本探测
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","server.js"]    # 配合 next.config.ts: output: "standalone"
```

---

## 附录 B:建议的新增环境变量

| 变量 | 建议默认 | 作用 | 章节 |
|---|---|---|---|
| `TRUST_PROXY` | `0` | 信任几层反代取真实 IP | §1.2 |
| `ALLOWED_HOSTS` | 空(取 `PUBLIC_BASE_URL`) | 限制可用于生成链接/水印的 Host | §1.9 |
| `DB_POOL_MAX` / `DB_STATEMENT_TIMEOUT_MS` | `10` / `20000` | 连接池与慢查询保护 | §5.4 |
| `IMAGE_CONCURRENCY` / `VIDEO_CONCURRENCY` / `HEIC_CONCURRENCY` | `min(4,CPU)` / `2` / `1` | 分池并发,取代单一的 `THUMB_CONCURRENCY` | §6.1 |
| `EXIF_READ_BYTES` | `1048576` | EXIF 只读文件头的字节数 | §6.1 |
| `SCAN_PRUNE_MAX_RATIO` | `0.3` | 扫描时允许一次清理的最大消失比例 | §2.1 |
| `MAX_UPLOAD_MB` | `2048` | 不再默认不限 | §1.8 |
| `MIN_FREE_DISK_MB` | `1024` | 磁盘剩余低于此值拒绝上传 | §1.8 |
| `GUEST_META` | `basic` | 游客可见的元数据级别 | §1.7 |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | 结构化日志 | §5.6 |
| `SECURITY_LOG_MAX_MB` | `50` | 安全日志轮转 | §5.6 |

---

## 附录 C:建议的实施顺序

### 第一阶段(一两天,纯修补,几乎无兼容性风险)

1. **§1.1 + §11.2 + §1.2 合并修**:失败计数下沉到 `verifyCredentials()`、时序均衡改用预计算常量、引入 `TRUST_PROXY`。这三条在同一文件、同一调用链,分开做会重复改三次。
2. **§5.4 连接池**:`error` 监听 + 无条件 `globalThis` 缓存 + 超时。约 10 行。
3. **§1.3 启动校验**:`NODE_ENV=production` 时拒绝占位密钥。
4. **§6.2 文件路径只选必要列** + 游客 `allowed` 集合缓存。
5. **§1.8 `readJson` 加大小上限**;`parseUpload` 加 `maxBytes`;`MAX_UPLOAD_MB` 默认值。
6. **§3.1 URI 解码错误返回 400**;`/media/upload` 全失败的响应格式。
7. **§11.4 `error` 字段对游客置空**;§11.5 加 `robots.txt` 与 `X-Robots-Tag`。
8. **§5.1 Dockerfile**:PID 1、`USER node`、healthcheck;文档补 Nginx 上传配置(§5.2)。

### 第二阶段(一周,数据可靠性与性能)

9. **§2.1 扫描熔断**(最小实现见 A.7),随后做软删除 + 重命名检测(§2.3)。这两条共用 `(size, mtime)` 比对逻辑,一起做。
10. **§2.2 先移动文件再改库**;逐项结果。
11. **§6.1 降低默认并发、只读 EXIF 头部、HEIC 独立限流、jemalloc**。
12. **§6.3 `invalidateAlbums` 防抖** + in-flight 复用;`/status` 缓存。
13. **§6.4 `pg_trgm` 索引** + 部分索引。
14. **§1.7 游客 EXIF 隐私开关** + **§11.3 备注搜索侧信道**;§1.10 挂载只读属性与重叠检查。

### 第三阶段(两周以上,架构与功能)

15. **§5.3 迁移体系**(drizzle `migrate()` + 版本表 + FK/CHECK)。
16. **§6.6 数据库驱动任务队列** + §2.8 Job API(导入/扫描/重生成异步化)。
17. **§3.3 个人访问令牌** + CLI `login`(§4.2)+ `util.parseArgs` 重写(§4.1)。
18. **§7.1 分享链接**;§7.3 视频转码预览;§6.2 `X-Accel-Redirect`。
19. **§8 测试体系**先覆盖"可见性矩阵"与"下载密钥",再进 CI。

---

## 附录 D:核对记录(源码位置对照)

供后续改动时快速定位。行号对应 commit `619d96a`。

| 结论 | 文件:行号 | 核对方式 |
|---|---|---|
| `clientIp` 取 XFF 第一段 | `router.ts:45-48` | 读源码 |
| `decodeURIComponent` 无 try/catch | `router.ts:40` | 读源码 |
| 默认管理员密码 `admin123456` | `config.ts:43` | 读源码 |
| 默认 `SESSION_SECRET` 由密码派生 | `config.ts:52` | 读源码 |
| `THUMB_CONCURRENCY` 默认 15 | `config.ts:60` | 读源码 |
| `MAX_UPLOAD_MB` 默认 0 | `config.ts:66` | 读源码 |
| `ALLOWED_MOUNT_ROOTS` 默认空 | `config.ts:70` | 读源码 |
| 版本号硬编码 | `config.ts:45` | 读源码 |
| `basicCache` 无上限 | `auth.ts:143,195-203` | 读源码 |
| `authenticate` 接受 Basic | `auth.ts:169-191` | 读源码 |
| `verifyCredentials` 无 rate limit | `auth.ts:193-204` | 读源码 |
| 失败路径双 scrypt | `auth.ts:197-201` | 读源码 |
| 改名分支删用户 | `auth.ts:222` | 读源码 |
| `sessionCookie` SameSite=Lax | `auth.ts:120-122` | 读源码 |
| 限流只在 login | `api/auth.ts:22-26` | 读源码 |
| icon 先写后查 2MB | `api/auth.ts:79-83` | 读源码 |
| upload 全失败仍 `ok:true` | `api/media.ts:92-93` | 读源码 |
| `/media` 为 public | `api/media.ts:18` | 读源码 |
| `/media-timeline` 为 public | `api/media.ts:135` | 读源码 |
| `serveMedia` 整行 select | `files.ts:117` | 读源码 |
| 派生图 `max-age=86400` | `files.ts:63` | 读源码 |
| 派生图已有 ETag/304 | `files.ts:56-70` | 读源码 |
| key 计数仅 Range 起点 0 | `files.ts:124` | 读源码 |
| `/f/:id` 游客回预览图 | `files.ts:136-140` | 读源码 |
| 扫描 gone 无熔断 | `albums.ts:519-523` | 读源码 |
| 删除顺序非原子 | `albums.ts:327-353` | 读源码 |
| 重名规避 50 次循环 | `albums.ts:374-384` | 读源码 |
| 移动失败仅 console.error | `albums.ts:385-395` | 读源码 |
| 删相册 move 不搬文件 | `albums.ts:413-425` | 读源码 |
| `visibleIds` 每次重算 Set | `albums.ts:89-95` | 读源码 |
| `localeCompare` 每次新建 collator | `albums.ts:44` | 读源码 |
| 先改库后移文件 | `service.ts:178-181` | 读源码 |
| 批量 move 先改库 | `service.ts:201-205` | 读源码 |
| `LIKE '%term%'` | `service.ts:80` | 读源码 |
| `mediaDetail` 返回全量 meta | `service.ts:136` | 读源码 |
| `mediaDetail` 返回 error | `service.ts:135` | 读源码 |
| `EXIF_MAX_BYTES` 64MB 全读 | `metadata.ts:114-130` | 读源码 |
| `search_text` 含 note | `metadata.ts:362-373` | 读源码 |
| `sharp.cache(false)` / `concurrency(2)` | `derive.ts:20-21` | 读源码 |
| `makeDerived` 3 次解码 | `derive.ts:49-57` | 读源码 |
| `invalidateAlbums` 每文件调用 | `ingest.ts:61,187` | 读源码 |
| `collectFiles` 用 `fs.stat` | `ingest.ts:204-215` | 读源码 |
| 判重用 `IS NOT DISTINCT FROM` | `ingest.ts:145` | 读源码 |
| `waiting.shift()` | `queue.ts:31` | 读源码 |
| 只恢复 5 万 pending | `ready.ts:30` | 读源码 |
| 连接池无 error 监听 | `db/index.ts` 全文 | 读源码 |
| 生产不缓存 globalThis | `db/index.ts:22-24` | 读源码 |
| `unblock` 换新 id | `blocklist.ts:111` | 读源码 |
| `randomId` 取模偏差 | `media/types.ts:42-48` | 读源码 |
| `npm start` 作 PID 1 | `Dockerfile:32` | 读源码 |
| 无 `USER` / 无 `HEALTHCHECK` | `Dockerfile` | 读源码 |
| 构建期占位 `DATABASE_URL` | `Dockerfile:15-18` | 读源码 |
| compose 暴露 3000 端口 | `docker-compose.yml:48-49` | 读源码 |
| 无安全响应头 | `next.config.ts` | 读源码 |
| 无 `robots.txt` | `public/` 目录 | 列目录 |
| HD 有 `X-Robots-Tag` | `hd/service.ts:200` | 读源码 |
| HD 每次重合成水印 | `hd/service.ts:186` | 读源码 |
| HD 缓存整张读入 + 复制 | `hd/cache.ts:102` / `hd/service.ts:190` | 读源码 |
| `layerCache` >12 逐个淘汰 | `hd/watermark.ts:116` | 读源码 |
| 无自动化测试 | `scripts/` 目录 | 列目录 |
| `lint`/`typecheck` 脚本已存在但 CI 未用 | `package.json` | 读源码 |
| `/api/v1/health` 与 `/api/health` 两套 | `admin.ts:109` / `app/api/health/route.ts` | 读源码 |

---

*本文档为整合版,合并了原始静态审查、逐条源码核对结果、6 处修正与 6 项新增发现。所有"已核对属实"的条目均可在上表定位到源码。涉及性能数字的部分是**数量级估算**,请以实际数据量压测为准。后续优化时,请以本文档章节编号(§)为引用依据,而非原始 issue。*
