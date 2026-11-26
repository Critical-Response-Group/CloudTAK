import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { h, defineComponent, type App } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import { createPinia } from 'pinia';
import { PluginAPI, MenuTemplate } from '@tak-ps/cloudtak';
import type { PluginInstance } from '@tak-ps/cloudtak';
import { useAppStore } from '../stores/app.ts';

const TestPanel = defineComponent({
    render: () => h(MenuTemplate, { name: 'Test Plugin' }, {
        buttons: () => h('button', { class: 'plugin-button' }, 'Refresh'),
        default: () => h('p', { class: 'plugin-body' }, 'Hello from a plugin')
    })
});

class TestPlugin implements PluginInstance {
    static async install(app: App, api: PluginAPI): Promise<PluginInstance> {
        api.routes.add({
            path: '/menu/test-plugin',
            name: 'home-menu-test-plugin',
            component: TestPanel
        });

        return new TestPlugin();
    }

    async enable(): Promise<void> {}

    async disable(): Promise<void> {}
}

async function renderPanel(mobile: boolean) {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/', component: { render: () => null } }]
    });
    const pinia = createPinia();

    const host = mount(RouterView, {
        attachTo: document.body,
        global: { plugins: [router, pinia] }
    });

    useAppStore(pinia).isMobileDetected = mobile;

    const app = host.vm.$.appContext.app;
    await TestPlugin.install(app, new PluginAPI(app, router, pinia));
    await router.push('/menu/test-plugin');
    await flushPromises();

    return host;
}

describe('MenuTemplate plugin export', () => {
    it('renders a plugin panel inline on desktop', async () => {
        const wrapper = await renderPanel(false);

        expect(wrapper.find('.main-menu-modal-frame').exists()).toBe(false);
        expect(wrapper.text()).toContain('Test Plugin');
        expect(wrapper.find('.plugin-button').exists()).toBe(true);
        expect(wrapper.find('.plugin-body').text()).toBe('Hello from a plugin');

        wrapper.unmount();
    });

    it('renders a plugin panel as a full screen modal on mobile', async () => {
        const wrapper = await renderPanel(true);

        const frame = document.body.querySelector('.main-menu-modal-frame');
        expect(frame).not.toBeNull();
        expect(frame?.querySelector('.modal-title')?.textContent).toBe('Test Plugin');
        expect(frame?.querySelector('.plugin-body')?.textContent).toBe('Hello from a plugin');

        wrapper.unmount();
    });
});
