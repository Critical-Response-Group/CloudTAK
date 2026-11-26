import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import type { Router } from 'vue-router';

const PATCH = vi.hoisted(() => vi.fn());

vi.mock('../std.ts', () => ({ server: { PATCH }, std: vi.fn(), stdurl: vi.fn() }));
vi.mock('../stores/map.ts', () => ({ useMapStore: () => ({}) }));
vi.mock('../stores/float.ts', () => ({ useFloatStore: () => ({}) }));

import { PluginAPI } from '../../plugin.ts';
import { db } from '../database.ts';

function pluginAPI(): PluginAPI {
    return new PluginAPI(createApp({}), {} as Router, createPinia());
}

describe('PluginAPI profile.setPluginSetting', () => {
    beforeEach(async () => {
        PATCH.mockReset();
        await db.profile.clear();
    });

    it('patches only plugin_settings and reads back the merged settings', async () => {
        PATCH.mockResolvedValue({
            data: { plugin_settings: { other: 'value', 'crg-map-layers': 'crg-authkey' } }
        });

        const api = pluginAPI();
        await api.profile.setPluginSetting('crg-map-layers', 'crg-authkey');

        expect(PATCH).toHaveBeenCalledWith('/api/profile', {
            body: { plugin_settings: { 'crg-map-layers': 'crg-authkey' } }
        });
        expect(await api.profile.get('plugin_settings')).toEqual({
            other: 'value',
            'crg-map-layers': 'crg-authkey'
        });
    });

    it('rejects and leaves the local profile unchanged when the server refuses', async () => {
        PATCH.mockResolvedValue({ error: { message: 'Validation Error' } });

        const api = pluginAPI();
        await expect(api.profile.setPluginSetting('not a key', 'value')).rejects.toThrow('Validation Error');
        expect(await api.profile.get('plugin_settings')).toBeUndefined();
    });
});
