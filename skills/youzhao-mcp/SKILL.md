---
name: youzhao-mcp
description: Use when Codex needs to install, configure, or operate the YouZhao blueprint MCP Server for blueprint work: list blueprint groups, list blueprints, inspect versions, fetch blueprint HTML/Markdown artifacts, publish or update blueprint versions, handle idempotent publishing, or troubleshoot blueprint MCP tool access. Do not use for platform deployment, server upgrades, user administration, or infrastructure operations.
---

# 有招 MCP

Use this skill when working with the YouZhao blueprint MCP Server. The MCP server is a stdio server at `server/mcp-server.mjs`; it exposes MCP tools and forwards tool calls to the YouZhao backend.

## Scope

This skill covers blueprint capabilities only:

- Read accessible blueprint groups.
- List accessible blueprints.
- Inspect blueprint metadata and versions.
- Fetch blueprint HTML and Markdown artifacts.
- Publish a new blueprint version or create a new blueprint through publish.
- Use `idempotencyKey` safely for retries.

This skill does not cover:

- Server deployment or upgrade.
- Frontend/backend service startup.
- Nginx, systemd, Docker, database, or backup operations.
- User, permission, or Token management UI work.

## MCP Server Install

In an MCP client, register a stdio server:

```json
{
  "mcpServers": {
    "youzhao": {
      "command": "node",
      "args": ["/absolute/path/to/YouZhao/server/mcp-server.mjs"],
      "env": {
        "YOUZHAO_API_BASE": "http://127.0.0.1:4174",
        "YOUZHAO_MCP_TOKEN": "your_mcp_token"
      }
    }
  }
}
```

Use an absolute path for `server/mcp-server.mjs`. The YouZhao backend API must be reachable at `YOUZHAO_API_BASE`.

## Inputs To Confirm

Before using the MCP tools, identify:

- API base URL in `YOUZHAO_API_BASE`.
- MCP Token in `YOUZHAO_MCP_TOKEN`.
- Target operation: read, inspect, fetch artifact, or publish.
- Target `blueprintId` and `version` when applicable.

Never invent production tokens. Use development tokens only in local development contexts explicitly marked as such.

## Blueprint Workflow

1. Use `youzhao.list_blueprint_groups` to discover authorized groups.
2. Use `youzhao.list_blueprints` to find a target blueprint.
3. Use `youzhao.get_blueprint` to inspect metadata and version history.
4. Use `youzhao.get_blueprint_artifact` to fetch current HTML or Markdown.
5. Generate or revise the blueprint HTML and Markdown.
6. Use `youzhao.publish_blueprint` to publish a new version.
7. Re-read the blueprint to verify the new latest version and preview URL.

For endpoint schemas and examples, read `references/http-tools.md`.

## Helper Script

Use `scripts/youzhao_mcp_smoke_test.mjs` to verify a configured MCP server process:

```bash
YOUZHAO_API_BASE=http://127.0.0.1:4174 \
YOUZHAO_MCP_TOKEN=yz_mcp_dev_admin \
node skills/youzhao-mcp/scripts/youzhao_mcp_smoke_test.mjs ./server/mcp-server.mjs
```

The smoke test starts the MCP server over stdio, calls `initialize`, `tools/list`, and `youzhao.list_blueprints`.

## Publish And Update Rules

Use publishing for both new versions and updates. Do not overwrite an existing version.

- Send both `html` and `markdown`.
- Use a unique `version` per blueprint.
- Prefer `idempotencyKey` for retries.
- HTML must include `<!doctype html>` or `<html`.
- Markdown must be non-empty.
- If updating an existing blueprint, include `blueprintId`.
- If creating a new blueprint, omit `blueprintId` and provide `name`, `summary`, `tags`, `groupId`, `version`, `html`, and `markdown`.
- After publishing, use returned `previewUrl` instead of constructing URLs manually.

## Troubleshooting

- `UNAUTHENTICATED`: token missing, invalid, disabled, expired, or wrong header.
- `SCOPE_DENIED`: token scope does not allow the requested tool.
- `FORBIDDEN`: bound user lacks platform permission.
- `BLUEPRINT_NOT_FOUND`: blueprint does not exist or is outside the bound user's authorization.
- `VERSION_CONFLICT`: version already exists; retry with the same `idempotencyKey` or choose another version.
- `INVALID_ARTIFACT`: HTML/Markdown validation failed.
- `接口不存在`: wrong tool path or wrong HTTP method. Tool calls must be `POST /api/mcp/tools/{toolName}`.
