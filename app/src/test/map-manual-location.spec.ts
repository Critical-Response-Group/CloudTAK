import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { flushPromises, shallowMount } from '@vue/test-utils';
import type { App } from 'vue';
import type { Router } from 'vue-router';
import type { MapGeoJSONFeature, MapMouseEvent } from 'maplibre-gl';
import { PluginAPI } from '../../plugin.ts';
import { useMapStore } from '../stores/map.ts';
import { useDeviceStore } from '../stores/device.ts';
import { DrawToolMode } from '../stores/modules/draw.ts';
import OverlayManager from '../base/overlay.ts';
import MapView from '../components/CloudTAK/Map.vue';
import GPSPanel from '../components/CloudTAK/GPSPanel/GPSPanel.vue';

vi.mock('vue-router', async (original) => ({
    ...await original<typeof import('vue-router')>(),
    useRouter: () => ({ push: vi.fn() }),
    useRoute: () => ({ path: '/', query: {}, params: {} })
}));

const PLUGIN_LAYER = 'crg-county-circles';

describe('setting the location by hand', () => {
    let pinia: Pinia;
    let once: Array<(e: MapMouseEvent) => void | Promise<void>>;
    const pluginClick = vi.fn();
    const update = vi.fn(async () => undefined);

    function mountMap() {
        const mapStore = useMapStore(pinia);
        const canvas = { style: { cursor: '' } };

        mapStore._map = {
            queryRenderedFeatures: () => [{ id: 'rockwall', layer: { id: PLUGIN_LAYER }, properties: { id: 'rockwall' } } as unknown as MapGeoJSONFeature],
            getCanvas: () => canvas,
            once: (_type: string, listener: (e: MapMouseEvent) => void) => { once.push(listener); },
            off: (_type: string, listener: (e: MapMouseEvent) => void) => { once = once.filter((l) => l !== listener); },
        } as never;
        mapStore._draw = { mode: DrawToolMode.STATIC, editing: null } as never;
        mapStore._menu = {} as never;
        mapStore._worker = {
            profile: { hasNoChannels: async () => false, hasNoConfiguration: async () => false, update },
            db: { remove: async () => undefined },
        } as never;
        mapStore.isMapLoaded = true;

        vi.spyOn(mapStore, 'init').mockResolvedValue();
        vi.spyOn(mapStore, 'destroy').mockResolvedValue();
        vi.spyOn(mapStore, 'refresh').mockResolvedValue();
        vi.spyOn(mapStore, 'startLocationWatch').mockResolvedValue();
        vi.spyOn(useDeviceStore(pinia), 'hasRequiredPermissions').mockReturnValue(true);

        new PluginAPI({} as App, {} as Router, pinia).click.add(PLUGIN_LAYER, pluginClick);

        const wrapper = shallowMount(MapView, { global: { plugins: [pinia], renderStubDefaultSlot: true } });
        return { mapStore, wrapper };
    }

    // MapLibre calls the store's click listener first, then any one-time
    // listener a location pick added later
    async function mapClick(mapStore: ReturnType<typeof useMapStore>): Promise<void> {
        const e = { point: { x: 400, y: 400 }, lngLat: { lng: -96, lat: 32 }, originalEvent: { ctrlKey: false } } as unknown as MapMouseEvent;
        const done = mapStore.onMapClick(e);
        await Promise.all(once.splice(0).map((listener) => listener(e)));
        await done;
    }

    async function armTwice(wrapper: ReturnType<typeof mountMap>['wrapper']): Promise<void> {
        await flushPromises();
        wrapper.findComponent(GPSPanel).vm.$emit('set-location');
        wrapper.findComponent(GPSPanel).vm.$emit('set-location');
        await flushPromises();
    }

    function savedCoordinates(): boolean {
        return update.mock.calls.some((call) => {
            const body = (call as unknown[])[0] as { tak_loc: unknown };
            return body.tak_loc !== null;
        });
    }

    beforeEach(() => {
        pinia = createPinia();
        setActivePinia(pinia);
        once = [];
        pluginClick.mockReset();
        update.mockClear();

        vi.spyOn(OverlayManager, 'clickableLayerMap').mockReturnValue(new Map());
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('leaves nothing armed after arming twice and cancelling', async () => {
        const { mapStore, wrapper } = mountMap();
        await armTwice(wrapper);

        await wrapper.find('[title="Cancel Manual Location"]').trigger('click');
        await mapClick(mapStore);

        expect(savedCoordinates()).toBe(false);
        expect(pluginClick).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it('leaves nothing armed after arming twice and choosing Use GPS', async () => {
        const { mapStore, wrapper } = mountMap();
        await armTwice(wrapper);

        await wrapper.find('.use-gps-btn').trigger('click');
        await flushPromises();
        await mapClick(mapStore);

        expect(savedCoordinates()).toBe(false);
        expect(pluginClick).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it('removes the pick and its click listener when the map unmounts mid-pick', async () => {
        const { mapStore, wrapper } = mountMap();
        await flushPromises();
        wrapper.findComponent(GPSPanel).vm.$emit('set-location');
        await flushPromises();
        expect(once).toHaveLength(1);

        wrapper.unmount();

        expect(once).toHaveLength(0);
        expect(mapStore._locationPicks.size).toBe(0);
    });

    it('saves the clicked location and gives the next click to the plugin', async () => {
        const { mapStore, wrapper } = mountMap();
        await flushPromises();
        wrapper.findComponent(GPSPanel).vm.$emit('set-location');
        await flushPromises();

        await mapClick(mapStore);
        expect(update).toHaveBeenCalledWith({ tak_loc: { type: 'Point', coordinates: [-96, 32] } });
        expect(pluginClick).not.toHaveBeenCalled();

        await mapClick(mapStore);
        expect(pluginClick).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });
});
