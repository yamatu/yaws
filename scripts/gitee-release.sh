#!/usr/bin/env bash
# Publish the agent builds as a Gitee release.
#
# Gitee has no `/releases/latest/download` alias, so the panel's 国内线路 asks the
# Gitee API for the newest tag and then downloads from
# `https://gitee.com/<repo>/releases/download/<tag>/<asset>`. Without a release
# there that source is skipped and the host falls back to the controller (which
# always works, just slower for a domestic host), so this runs on every tag.
#
# Usage: GITEE_TOKEN=<token> scripts/gitee-release.sh v0.3.0 [owner/repo]
# Re-running an already published tag is safe: assets that already exist are
# left alone.
set -euo pipefail

tag="${1:-}"
repo="${2:-${GITEE_REPO:-}}"
if [ -z "$tag" ]; then
  echo "用法: GITEE_TOKEN=<token> $0 <tag> [owner/repo]" >&2
  exit 2
fi
token="${GITEE_TOKEN:-}"
if [ -z "$token" ]; then
  echo "需要 GITEE_TOKEN（https://gitee.com/profile/personal_access_tokens）" >&2
  exit 2
fi
[ -n "$repo" ] || repo="yamatu/yaws"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$root/agent/bin"
notes="$root/docs/releases/$tag.md"
api="https://gitee.com/api/v5/repos/$repo"
assets=(yaws-agent-linux-amd64 yaws-agent-linux-arm64 SHA256SUMS)

for asset in "${assets[@]}"; do
  if [ ! -s "$bin/$asset" ]; then
    echo "缺少文件: $bin/$asset" >&2
    exit 1
  fi
done

# The release body travels as JSON; escape the notes without needing jq/python.
json_string() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  text="${text//$'\r'/}"
  text="${text//$'\n'/\\n}"
  text="${text//$'\t'/\\t}"
  printf '%s' "$text"
}
body="$(json_string "$(cat "$notes" 2>/dev/null || echo "yaws $tag")")"

# Gitee answers `null` (HTTP 200) for a tag it has no release for.
echo "查询 Gitee 发行版 $tag ($repo)"
lookup="$(curl -fsS "$api/releases/tags/$tag?access_token=$token" || true)"
# First `"id":` in the object is the release itself (the author object comes later).
id="$(printf '%s' "$lookup" | grep -o '"id":[0-9]*' | head -n1 | cut -d: -f2)"

if [ -z "$id" ]; then
  echo "创建发行版 $tag"
  created="$(curl -fsS -X POST "$api/releases" \
    -H "Content-Type: application/json;charset=UTF-8" \
    --data-binary "{\"access_token\":\"$token\",\"tag_name\":\"$tag\",\"name\":\"$tag\",\"target_commitish\":\"main\",\"prerelease\":false,\"body\":\"$body\"}")"
  id="$(printf '%s' "$created" | grep -o '"id":[0-9]*' | head -n1 | cut -d: -f2)"
  if [ -z "$id" ]; then
    echo "创建失败: $created" >&2
    exit 1
  fi
  echo "  发行版 id=$id"
fi

# Gitee keeps uploading instead of rejecting a duplicate name, so check first.
published="$(curl -fsS "$api/releases/$id/attach_files?access_token=$token")"
for asset in "${assets[@]}"; do
  echo "上传 $asset"
  if printf '%s' "$published" | grep -q "\"name\":\"$asset\""; then
    echo "  已发布，跳过"
    continue
  fi
  uploaded="$(curl -fsS -X POST "$api/releases/$id/attach_files" \
    -F "access_token=$token" -F "file=@$bin/$asset")"
  if printf '%s' "$uploaded" | grep -q '"browser_download_url"'; then
    echo "  完成"
  else
    echo "  上传失败: $uploaded" >&2
    exit 1
  fi
done

echo "发行版地址: https://gitee.com/$repo/releases/tag/$tag"
