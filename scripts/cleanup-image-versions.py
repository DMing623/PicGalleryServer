#!/usr/bin/env python3
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""
清理 GHCR 容器包中的历史版本:只保留【最新】与【前一个】两次构建的镜像。

背景:
  多架构镜像(linux/amd64 + linux/arm64)每次构建会在 GHCR 中产生多个 package version
  (一个带标签的主版本 + 各架构的无标签版本)。若直接按 version 数量截断,
  实际只会留下最新一次构建。因此这里先按【构建】聚类,再保留最近两次构建。

用法(在 GitHub Actions 中):
  先用 gh api 把版本列表导出为 JSONL(每行一个 {id, created_at, tags}),
  再执行: python3 scripts/cleanup-image-versions.py /tmp/vers.jsonl
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

KEEP_BUILDS = 2  # 保留最近两次构建
GAP = timedelta(seconds=60)  # 同一构建的各架构 version 创建时间相差仅数秒


def parse_dt(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def gh_api_delete(owner: str, repo: str, version_id: int) -> bool:
    """删除一个 package version,依次尝试个人账户与组织两种归属。"""
    for base in (
        f"/users/{owner}/packages/container/{repo}/versions/{version_id}",
        f"/orgs/{owner}/packages/container/{repo}/versions/{version_id}",
    ):
        r = subprocess.run(
            ["gh", "api", "-X", "DELETE", base],
            capture_output=True,
            text=True,
            env={**os.environ, "GH_TOKEN": os.environ.get("GH_TOKEN", "")},
        )
        if r.returncode == 0:
            return True
    return False


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: cleanup-image-versions.py <versions.jsonl>", file=sys.stderr)
        return 2

    owner = os.environ.get("OWNER", "")
    repo = os.environ.get("REPO", "")
    if not owner or not repo:
        print("缺少环境变量 OWNER / REPO", file=sys.stderr)
        return 2

    vers = []
    with open(sys.argv[1], encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            v = json.loads(line)
            v["dt"] = parse_dt(v["created_at"])
            vers.append(v)
    if not vers:
        print("没有可清理的版本")
        return 0

    vers.sort(key=lambda v: v["dt"], reverse=True)

    # 聚类:创建时间间隔小于 GAP 的视为同一次构建
    builds: list[list[dict]] = []
    for v in vers:
        if builds and (builds[-1][-1]["dt"] - v["dt"]) < GAP:
            builds[-1].append(v)
        else:
            builds.append([v])

    print(f"共 {len(vers)} 个 version,聚类为 {len(builds)} 次构建")
    keep_ids = set()
    for i, b in enumerate(builds):
        tags = ",".join(sorted({t for v in b for t in v["tags"]})) or "(无标签)"
        action = "保留" if i < KEEP_BUILDS else "删除"
        print(f"  [{action}] 构建#{i+1}  {b[0]['dt'].strftime('%Y-%m-%d %H:%M:%S')}Z  {len(b)} 个 version  标签={tags}")
        if i < KEEP_BUILDS:
            keep_ids.update(v["id"] for v in b)

    failed = []
    skipped = 0
    deleted = 0
    for v in vers:
        if v["id"] in keep_ids:
            continue
        # 安全规则:带 latest 标签的版本永不删除(latest 永远指向最新构建)
        if "latest" in v["tags"]:
            print(f"  [跳过] {v['id']} 带 latest 标签")
            skipped += 1
            continue
        ok = gh_api_delete(owner, repo, v["id"])
        if ok:
            deleted += 1
        else:
            failed.append(v["id"])
        print(f"  [{'已删除' if ok else '删除失败'}] {v['id']}  {v['created_at']}  {','.join(v['tags']) or '(无标签)'}")

    print(f"\n保留 {len(keep_ids)} 个 version,删除 {deleted} 个,跳过 {skipped} 个,失败 {len(failed)} 个")
    if failed:
        print(f"::warning::以下版本删除失败: {', '.join(map(str, failed))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
