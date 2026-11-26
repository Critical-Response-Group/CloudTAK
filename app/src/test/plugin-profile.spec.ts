import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import type { Router } from 'vue-router';

const update = vi.hoisted(() => vi.fn());

vi.mock('../stores/map.ts', () => ({ useMapStore: () => ({ worker: { profile: { update } } }) }));
vi.mock('../stores/float.ts', () => ({ useFloatStore: () => ({}) }));

import { PluginAPI } from '../../plugin.ts';

function pluginAPI(): PluginAPI {
    return new PluginAPI(createApp({}), {} as Router, createPinia());
}

describe('PluginAPI profile.setPluginSetting', () => {
    beforeEach(() => {
        update.mockReset();
    });

    it('saves only its own key through the profile update the Settings menu uses', async () => {
        update.mockResolvedValue(undefined);

        await pluginAPI().profile.setPluginSetting('crg-map-layers', 'crg-authkey');

        expect(update).toHaveBeenCalledWith({ plugin_settings: { 'crg-map-layers': 'crg-authkey' } });
    });

    it('rejects when the profile update fails', async () => {
        update.mockRejectedValue(new Error('Validation Error'));

        await expect(pluginAPI().profile.setPluginSetting('not a key', 'value')).rejects.toThrow('Validation Error');
    });
});
