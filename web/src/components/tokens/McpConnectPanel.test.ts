import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import McpConnectPanel from './McpConnectPanel.vue';
import { ApiError } from '@/services/api';
import type { McpConnectionInfo, TokenSelfCheck } from '@/services/endpoints';

const { fetchMcpConnectionInfo, verifyToken, toastAdd } = vi.hoisted(() => ({
  fetchMcpConnectionInfo: vi.fn(),
  verifyToken: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock('@/services/endpoints', () => ({ fetchMcpConnectionInfo, verifyToken }));
vi.mock('primevue/usetoast', () => ({ useToast: () => ({ add: toastAdd }) }));

const INFO: McpConnectionInfo = {
  enabled: true,
  httpUrl: 'https://youzhao.florai.cn/mcp',
  path: '/mcp',
  transport: 'streamable-http',
  authHeader: 'Authorization',
  authScheme: 'Bearer',
  protocol: { negotiatedBy: 'client-initialize', modernEra: true, legacyEra: true },
  oauth: { enabled: false, note: '只支持 Bearer Token；需要 OAuth 的客户端请用 mcp-remote 兜底。' },
  tools: { total: 8, read: 4, write: 4 },
  scopes: ['read:blueprint', 'publish:blueprint'],
  tokenPagePath: '/settings/tokens',
};

const CHECK_OK: TokenSelfCheck = {
  ok: true,
  tokenId: 'tok_1',
  tokenPrefix: 'yz_mcp_tok_1',
  scopes: ['read:blueprint'],
  serverInfo: { name: 'youzhao', version: '2.0.0' },
  protocolVersion: '2025-06-18',
  toolCount: 4,
  tools: [{ name: 'youzhao.list_blueprints', title: '列出蓝图', scope: 'read:blueprint' }],
  latencyMs: 218,
};

function mountPanel(props: { tokenPlaintext?: string | null; canCreateToken?: boolean } = {}): VueWrapper {
  return mount(McpConnectPanel, {
    props,
    global: { plugins: [PrimeVue] },
  });
}

function findButton(wrapper: VueWrapper, label: string) {
  return wrapper.findAll('button').find((button) => button.text().includes(label));
}

async function ready(): Promise<VueWrapper> {
  const wrapper = mountPanel();
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  // vitest 配置了 restoreMocks：每个用例前必须重新给实现。
  fetchMcpConnectionInfo.mockReset();
  verifyToken.mockReset();
  toastAdd.mockReset();
  fetchMcpConnectionInfo.mockResolvedValue(INFO);
});

describe('McpConnectPanel', () => {
  it('接入地址来自服务端，不在前端拼地址', async () => {
    const wrapper = await ready();

    expect(fetchMcpConnectionInfo).toHaveBeenCalledTimes(1);
    expect(wrapper.find('code.connect-value').text()).toBe('https://youzhao.florai.cn/mcp');
    expect(wrapper.text()).toContain('共 8 个工具：4 个读工具、4 个写工具');
    expect(wrapper.text()).not.toContain('127.0.0.1:4174');
    expect(wrapper.find('input').exists()).toBe(true);
  });

  it('未开启 MCP 时给出可照做的出口，并可重新加载', async () => {
    fetchMcpConnectionInfo.mockRejectedValueOnce(
      new ApiError(503, 'MCP_DISABLED', '未开启 MCP 接入（MCP_ENABLED=false）'),
    );
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.text()).toContain('加载失败');
    expect(wrapper.text()).toContain('MCP_ENABLED=false');
    expect(wrapper.find('input').exists()).toBe(false);

    const retry = findButton(wrapper, '重新加载');
    expect(retry).toBeDefined();
    await retry?.trigger('click');
    await flushPromises();
    expect(fetchMcpConnectionInfo).toHaveBeenCalledTimes(2);
  });

  it('自检成功后展示结果，且排在客户端片段之前', async () => {
    verifyToken.mockResolvedValue(CHECK_OK);
    const wrapper = await ready();

    await wrapper.find('input').setValue('yz_mcp_tok_1_secret');
    await findButton(wrapper, '检测连接')?.trigger('click');
    await flushPromises();

    expect(verifyToken).toHaveBeenCalledWith('yz_mcp_tok_1_secret');
    const ok = wrapper.find('p.connect-ok');
    expect(ok.exists()).toBe(true);
    expect(ok.text()).toContain('✓ 连接正常');
    expect(ok.text()).toContain('协议 2025-06-18');
    expect(ok.text()).toContain('可见 4 个工具（只读）');
    expect(ok.text()).toContain('218 ms');

    const code = wrapper.find('pre.snippet-code');
    expect(code.exists()).toBe(true);
    expect(ok.element.compareDocumentPosition(code.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('空输入不发自检请求，只提示先填 Token', async () => {
    const wrapper = await ready();

    await findButton(wrapper, '检测连接')?.trigger('click');
    await flushPromises();

    expect(verifyToken).not.toHaveBeenCalled();
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warn', summary: '先填入 Token' }));
  });

  it('TOKEN_INVALID 翻成中文并给下一步', async () => {
    verifyToken.mockRejectedValue(new ApiError(401, 'TOKEN_INVALID', 'Token 无效、已停用或已过期'));
    const wrapper = await ready();

    await wrapper.find('input').setValue('yz_mcp_tok_1_secret');
    await findButton(wrapper, '检测连接')?.trigger('click');
    await flushPromises();

    const fail = wrapper.find('p.text-danger');
    expect(fail.exists()).toBe(true);
    expect(fail.text()).toContain('✗');
    expect(fail.text()).toContain('重新创建');
  });

  it('可创建 Token 时只暴露一个创建入口并向上 emit', async () => {
    const wrapper = mountPanel({ canCreateToken: true });
    await flushPromises();

    // 页面级主色按钮全页唯一（页头的「连接 Agent」）：面板里不再放第二个主色「创建 Token」
    expect(findButton(wrapper, '创建 Token')).toBeUndefined();

    const createInCheck = findButton(wrapper, '创建新 Token');
    expect(createInCheck).toBeDefined();
    await createInCheck?.trigger('click');
    expect(wrapper.emitted('createToken')).toHaveLength(1);
  });

  it('不可创建 Token 时不出现任何创建入口', async () => {
    const wrapper = await ready();

    expect(findButton(wrapper, '创建 Token')).toBeUndefined();
    expect(findButton(wrapper, '创建新 Token')).toBeUndefined();
  });
});
