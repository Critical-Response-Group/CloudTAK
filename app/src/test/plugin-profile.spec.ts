import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import type { Router } from 'vue-router';

const { GET, PATCH } = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn() }));

vi.mock('../std.ts', () => ({ server: { GET, PATCH }, std: vi.fn(), stdurl: vi.fn() }));
vi.mock('../stores/map.ts', () => ({ useMapStore: () => ({}) }));
vi.mock('../stores/float.ts', () => ({ useFloatStore: () => ({}) }));

import { PluginAPI } from '../../plugin.ts';
import { db } from '../database.ts';
import ProfileConfig from '../base/profile.ts';

function pluginAPI(): PluginAPI {
    return new PluginAPI(createApp({}), {} as Router, createPinia());
}

describe('PluginAPI profile.setPluginSetting', () => {
    beforeEach(async () => {
        GET.mockReset();
        PATCH.mockReset();
        await db.profile.clear();
    });

    it('patches only its own key and keeps the other plugin settings', async () => {
        await db.profile.put({ key: 'plugin_settings', value: { other: 'value' } });
        PATCH.mockResolvedValue({ data: {} });

        const api = pluginAPI();
        await api.profile.setPluginSetting('crg-map-layers', 'crg-authkey');

        expect(PATCH).toHaveBeenCalledWith('/api/profile', {
            body: { plugin_settings: { 'crg-map-layers': 'crg-authkey' } }
        });
        expect(await api.profile.get('plugin_settings')).toEqual({
            other: 'value',
            'crg-map-layers': 'crg-authkey'
        });

        await api.profile.setPluginSetting('other', '');
        expect(await api.profile.get('plugin_settings')).toEqual({ 'crg-map-layers': 'crg-authkey' });
    });

    it('keeps the newest settings when an older response arrives last', async () => {
        const stored: Record<string, string> = {};
        const delays = [20, 0];

        PATCH.mockImplementation(async (_url: string, opts: { body: { plugin_settings: Record<string, string> } }) => {
            Object.assign(stored, opts.body.plugin_settings);
            const data = { plugin_settings: { ...stored } };
            await new Promise((resolve) => setTimeout(resolve, delays.shift()));
            return { data };
        });

        const api = pluginAPI();
        await Promise.all([
            api.profile.setPluginSetting('first', 'one'),
            api.profile.setPluginSetting('second', 'two')
        ]);

        expect(await api.profile.get('plugin_settings')).toEqual({ first: 'one', second: 'two' });
    });

    it('keeps a new setting when an older profile refresh lands after it', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        GET.mockImplementation(async () => {
            const snapshot = { plugin_settings: {} };
            await gate;
            return { data: snapshot };
        });
        PATCH.mockResolvedValue({ data: { plugin_settings: { 'crg-map-layers': 'crg-authkey' } } });

        const api = pluginAPI();
        const refresh = ProfileConfig.sync({ refresh: true });
        await api.profile.setPluginSetting('crg-map-layers', 'crg-authkey');
        release();
        await refresh;

        expect(await api.profile.get('plugin_settings')).toEqual({ 'crg-map-layers': 'crg-authkey' });
    });

    it('rejects and leaves the local profile unchanged when the server refuses', async () => {
        PATCH.mockResolvedValue({ error: { message: 'Validation Error' } });

        const api = pluginAPI();
        await expect(api.profile.setPluginSetting('not a key', 'value')).rejects.toThrow('Validation Error');
        expect(await api.profile.get('plugin_settings')).toBeUndefined();
    });
});
