/**
 * 状态块三态（设计 §3）：空态、失败态、就绪态都必须是「有出口」的界面，
 * 失败态不给重试按钮的写法在评审里被列为反例，这里把它固化成用例。
 *
 * 挂真实 PrimeVue 插件而不是桩组件：桩组件上的 trigger 会同时触发组件事件
 * 和根元素原生事件，回调计数会翻倍，测出来的数字没有意义。
 */
import { mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { describe, expect, it, vi } from 'vitest';

import StateBlock from './StateBlock.vue';

const global = { plugins: [PrimeVue] };

describe('StateBlock', () => {
  it('加载态给出可见的进行中提示', () => {
    const wrapper = mount(StateBlock, { props: { state: 'loading' }, global });
    expect(wrapper.text()).toContain('正在加载');
  });

  it('失败态渲染说明与「重新加载」', async () => {
    const onRetry = vi.fn();
    const wrapper = mount(StateBlock, {
      props: { state: 'error', description: '无法连接服务端，请稍后重试。', onRetry },
      global,
    });
    expect(wrapper.text()).toContain('加载失败');
    expect(wrapper.text()).toContain('无法连接服务端，请稍后重试。');

    const button = wrapper.find('button');
    expect(button.text()).toBe('重新加载');
    await button.trigger('click');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('retry')).toHaveLength(1);
  });

  it('失败态没给出口时不渲染按钮（调用方必须自己补出口）', () => {
    const wrapper = mount(StateBlock, { props: { state: 'error' }, global });
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('空态渲染自定义标题与主操作', async () => {
    const onAction = vi.fn();
    const wrapper = mount(StateBlock, {
      props: {
        state: 'empty',
        title: '还没有蓝图',
        description: '新建蓝图后这里会列出产物。',
        actionLabel: '新建蓝图',
        onAction,
      },
      global,
    });
    expect(wrapper.text()).toContain('还没有蓝图');
    await wrapper.find('button').trigger('click');
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('action')).toHaveLength(1);
  });

  it('就绪态透传默认插槽', () => {
    const wrapper = mount(StateBlock, {
      props: { state: 'ready' },
      slots: { default: '<p class="real">真实内容</p>' },
      global,
    });
    expect(wrapper.find('.real').exists()).toBe(true);
  });
});
