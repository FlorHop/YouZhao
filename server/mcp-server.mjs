const apiBase = (process.env.YOUZHAO_API_BASE ?? 'http://127.0.0.1:4174').replace(/\/$/, '');
const mcpToken = process.env.YOUZHAO_MCP_TOKEN;
const protocolVersion = '2024-11-05';

const tools = [
  {
    name: 'youzhao.list_blueprint_groups',
    description: 'List blueprint groups accessible to the bound YouZhao MCP token.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Optional group name keyword.' },
        includeEmpty: { type: 'boolean', description: 'Whether to include empty groups.', default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: 'youzhao.list_blueprints',
    description: 'List blueprints accessible to the bound YouZhao MCP token.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string' },
        keyword: { type: 'string' },
        tag: { type: 'string' },
        limit: { type: 'number', default: 20 },
        offset: { type: 'number', default: 0 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'youzhao.get_blueprint',
    description: 'Get blueprint metadata and version list.',
    inputSchema: {
      type: 'object',
      required: ['blueprintId'],
      properties: {
        blueprintId: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'youzhao.get_blueprint_artifact',
    description: 'Fetch blueprint HTML or Markdown artifact for a version.',
    inputSchema: {
      type: 'object',
      required: ['blueprintId', 'artifactType'],
      properties: {
        blueprintId: { type: 'string' },
        version: { type: 'string', description: 'Optional version; latest is used when omitted.' },
        artifactType: { type: 'string', enum: ['html', 'markdown'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'youzhao.publish_blueprint',
    description: 'Publish a new blueprint version, or create a blueprint when blueprintId is omitted.',
    inputSchema: {
      type: 'object',
      required: ['name', 'version', 'html', 'markdown'],
      properties: {
        blueprintId: { type: 'string' },
        name: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        groupId: { type: 'string' },
        version: { type: 'string' },
        html: { type: 'string' },
        markdown: { type: 'string' },
        publishNote: { type: 'string' },
        idempotencyKey: { type: 'string' }
      },
      additionalProperties: false
    }
  }
];

let inputBuffer = Buffer.alloc(0);

function sendMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data
    }
  });
}

function tryReadMessage() {
  const separator = inputBuffer.indexOf('\r\n\r\n');
  if (separator < 0) return null;

  const header = inputBuffer.subarray(0, separator).toString('utf8');
  const match = header.match(/content-length:\s*(\d+)/i);
  if (!match) {
    inputBuffer = inputBuffer.subarray(separator + 4);
    throw new Error('Missing Content-Length header');
  }

  const length = Number(match[1]);
  const bodyStart = separator + 4;
  const bodyEnd = bodyStart + length;
  if (inputBuffer.length < bodyEnd) return null;

  const body = inputBuffer.subarray(bodyStart, bodyEnd).toString('utf8');
  inputBuffer = inputBuffer.subarray(bodyEnd);
  return JSON.parse(body);
}

async function callYouzhaoTool(toolName, args = {}) {
  if (!mcpToken) {
    throw new Error('YOUZHAO_MCP_TOKEN is required');
  }

  const response = await fetch(`${apiBase}/api/mcp/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${mcpToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error ?? {};
    throw new Error(error.message || `YouZhao API request failed: ${response.status}`);
  }
  return payload.data ?? payload;
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (!method) return;

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion,
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'youzhao-mcp-server',
        version: '0.1.0'
      }
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    sendResult(id, { tools });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (!tools.some((tool) => tool.name === name)) {
      sendError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    try {
      const data = await callYouzhaoTool(name, args);
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(data, null, 2)
          }
        ]
      });
    } catch (error) {
      sendResult(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error)
          }
        ]
      });
    }
    return;
  }

  if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
}

process.stdin.on('data', async (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  try {
    let message;
    while ((message = tryReadMessage())) {
      await handleRequest(message);
    }
  } catch (error) {
    sendError(null, -32700, error instanceof Error ? error.message : 'Parse error');
  }
});

process.stdin.resume();
