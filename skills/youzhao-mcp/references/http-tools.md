# 有招蓝图 MCP Tools Reference

This reference covers blueprint MCP tools only. It does not cover platform deployment, user management, Token creation, server upgrades, or infrastructure operations.

## Authentication

The MCP server reads authentication from environment variables:

```bash
YOUZHAO_API_BASE=http://127.0.0.1:4174
YOUZHAO_MCP_TOKEN=<mcp-token>
```

The MCP Token must already exist. Final blueprint capability is:

```text
bound user blueprint permission ∩ token scope
```

## MCP Server

The MCP server is `server/mcp-server.mjs`. MCP clients should connect to it over stdio. Internally, the server forwards tool calls to the YouZhao backend.

## `youzhao.list_blueprint_groups`

Purpose: list blueprint groups the Token can access. Use this before publishing to choose a valid `groupId`.

Request:

```json
{
  "keyword": "招商",
  "includeEmpty": true
}
```

Response:

```json
{
  "items": [
    {
      "id": "group_default",
      "name": "默认",
      "isDefault": true,
      "order": 0,
      "blueprintCount": 1,
      "createdAt": "2026-06-12 09:00"
    }
  ],
  "total": 1
}
```

## `youzhao.list_blueprints`

Purpose: list blueprints the Token can access.

Request:

```json
{
  "groupId": "group_default",
  "keyword": "招商",
  "tag": "驾驶舱",
  "limit": 20,
  "offset": 0
}
```

Response:

```json
{
  "items": [
    {
      "id": "demo_invest_001",
      "name": "招商驾驶舱",
      "summary": "展示招商线索、在谈项目、签约金额与落地进展。",
      "tags": ["招商", "驾驶舱"],
      "groupId": "group_invest",
      "latestVersion": "v1.1.0",
      "updatedAt": "2026-06-12 09:30"
    }
  ],
  "total": 1
}
```

## `youzhao.get_blueprint`

Purpose: get blueprint metadata and version history.

Request:

```json
{
  "blueprintId": "demo_invest_001"
}
```

Response:

```json
{
  "id": "demo_invest_001",
  "name": "招商驾驶舱",
  "summary": "展示招商线索、在谈项目、签约金额与落地进展。",
  "tags": ["招商", "驾驶舱"],
  "groupId": "group_invest",
  "latestVersion": "v1.1.0",
  "versions": [
    {
      "id": "ver_invest_101",
      "version": "v1.1.0",
      "isLatest": true,
      "status": "available",
      "previewUrl": "/blueprints/demo_invest_001/preview?version=v1.1.0",
      "artifactUrl": "/preview-artifacts/demo_invest_001/v1.1.0/index.html",
      "artifacts": ["html", "markdown"],
      "publishedAt": "2026-06-12 12:00"
    }
  ]
}
```

## `youzhao.get_blueprint_artifact`

Purpose: fetch blueprint HTML or Markdown for a version. If `version` is omitted, latest version is used.

Request:

```json
{
  "blueprintId": "demo_invest_001",
  "version": "v1.1.0",
  "artifactType": "markdown"
}
```

Response:

```json
{
  "blueprintId": "demo_invest_001",
  "version": "v1.1.0",
  "artifactType": "markdown",
  "content": "# 招商驾驶舱 v1.1.0\n\n...",
  "contentType": "text/markdown",
  "updatedAt": "2026-06-12 12:00"
}
```

## `youzhao.publish_blueprint`

Purpose: publish a new blueprint version. Use this as the update operation: create a new version, never overwrite an old version. If `blueprintId` is omitted, the backend creates a new blueprint with its first version.

Request:

```json
{
  "blueprintId": "demo_default_001",
  "name": "项目交付进度看板",
  "summary": "展示项目阶段、风险、评审、原型版本和交付物状态。",
  "tags": ["交付", "项目管理"],
  "groupId": "group_default",
  "version": "v1.1.0",
  "html": "<!doctype html><html><body><h1>Blueprint</h1></body></html>",
  "markdown": "# 项目交付进度看板\n\n版本说明。",
  "publishNote": "更新交付进度模块。",
  "idempotencyKey": "agent-job-001"
}
```

Response:

```json
{
  "blueprintId": "demo_default_001",
  "versionId": "version_abcd1234",
  "version": "v1.1.0",
  "isLatest": true,
  "previewUrl": "/blueprints/demo_default_001/preview?version=v1.1.0",
  "artifacts": {
    "html": true,
    "markdown": true
  },
  "htmlHash": "sha256:...",
  "markdownHash": "sha256:...",
  "htmlSize": 1200,
  "markdownSize": 200,
  "publishedAt": "2026-06-29T00:00:00.000Z"
}
```

Rules:

- `version` must be unique inside a blueprint unless using the same `idempotencyKey`.
- Same `idempotencyKey` returns the original result.
- Use the same `idempotencyKey` when retrying the same publish job after a timeout or network error.
- Use a new `version` for every real content update.
- HTML size limit defaults to 2 MB.
- Markdown size limit defaults to 512 KB.
- Publishing requires `publish:blueprint` and bound user blueprint manage permission.
- The response `previewUrl` is authoritative; do not construct preview URLs manually.

## Error Codes

| Code | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | Token missing, invalid, expired, or disabled |
| `SCOPE_DENIED` | Token does not have required scope |
| `FORBIDDEN` | Bound user has insufficient permission |
| `BLUEPRINT_NOT_FOUND` | Blueprint missing or inaccessible |
| `VERSION_NOT_FOUND` | Version missing or inaccessible |
| `VERSION_CONFLICT` | Version already exists |
| `GROUP_NOT_FOUND` | Group missing or inaccessible |
| `INVALID_ARGUMENT` | Invalid request field |
| `INVALID_ARTIFACT` | HTML or Markdown failed validation |
| `PAYLOAD_TOO_LARGE` | Request payload is too large |
| `PUBLISH_FAILED` | Artifact write or publish failed |
