import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { mount } from '@vue/test-utils';
import type { App } from 'vue';
import type { Router } from 'vue-router';
import type { MapGeoJSONFeature, MapMouseEvent } from 'maplibre-gl';
import { PluginAPI } from '../../plugin.ts';
import { useMapStore } from '../stores/map.ts';
import { DrawToolMode } from '../stores/modules/draw.ts';
import OverlayManager from '../base/overlay.ts';
import HistoryLayer, { HISTORY_POINT_LAYER } from '../stores/modules/history.ts';
import SearchBox from '../components/CloudTAK/util/SearchBox.vue';

vi.mock('vue-router', async (original) => ({
    ...await original<typeof import('vue-router')>(),
    useRouter: () => ({ push: vi.fn() })
}));

const COT_LAYER = '-1-point';
const PLUGIN_LAYER = 'crg-county-circles';
const UNCLAIMED_LAYER = 'crg-county-names';

function feature(layer: string, id: string): MapGeoJSONFeature {
    return {
        type: 'Feature',
        id,
        layer: { id: layer },
        properties: { id },
        geometry: { type: 'Point', coordinates: [-96, 32] }
    } as unknown as MapGeoJSONFeature;
}

function click(opts: { ctrlKey?: boolean } = {}): MapMouseEvent {
    const lngLat = { lng: -96, lat: 32, wrap: () => lngLat };
    return {
        point: { x: 400, y: 400 },
        lngLat,
        originalEvent: { ctrlKey: !!opts.ctrlKey }
    } as unknown as MapMouseEvent;
}

describe('map click ownership', () => {
    let pinia: Pinia;
    let rendered: MapGeoJSONFeature[];
    let lookup: (id: string) => Promise<unknown>;
    let once: Array<(e: MapMouseEvent) => void>;
    const pluginClick = vi.fn();
    const query = vi.fn(() => rendered);

    function plugin() {
        return new PluginAPI({} as App, {} as Router, pinia);
    }

    function setup() {
        const mapStore = useMapStore(pinia);
        const draw = { mode: DrawToolMode.STATIC, editing: null };
        const canvas = { style: { cursor: '' } };

        mapStore._map = {
            queryRenderedFeatures: query,
            getCanvas: () => canvas,
            once: (_type: string, listener: (e: MapMouseEvent) => void) => { once.push(listener); },
            off: (_type: string, listener: (e: MapMouseEvent) => void) => { once = once.filter((l) => l !== listener); },
        } as never;
        mapStore._draw = draw as never;
        mapStore._worker = { db: { get: (id: string) => lookup(id) } } as never;

        const dispose = plugin().click.add(PLUGIN_LAYER, pluginClick);

        return { mapStore, draw, dispose };
    }

    // MapLibre calls the store's click listener first, then any one-time
    // listener a location pick added later
    async function mapClick(mapStore: ReturnType<typeof useMapStore>): Promise<void> {
        const e = click();
        const done = mapStore.onMapClick(e);
        for (const listener of once.splice(0)) listener(e);
        await done;
    }

    function routeEndpoint() {
        return mount(SearchBox, { props: { locationPicker: true } });
    }

    beforeEach(() => {
        pinia = createPinia();
        setActivePinia(pinia);
        rendered = [];
        lookup = async (id) => ({ id });
        once = [];
        pluginClick.mockReset();
        query.mockClear();

        vi.spyOn(OverlayManager, 'clickableLayerMap').mockReturnValue(new Map([
            [COT_LAYER, { type: 'cot', id: COT_LAYER }]
        ]));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('gives a click on a plugin feature to the plugin, before the click resolves', async () => {
        const { mapStore } = setup();
        const county = feature(PLUGIN_LAYER, 'rockwall');
        rendered = [county];

        const e = click();
        const done = mapStore.onMapClick(e);
        expect(pluginClick).toHaveBeenCalledExactlyOnceWith(county, e);
        await done;

        expect(mapStore.radial.mode).toBeUndefined();
        expect(mapStore.select.feats).toEqual([]);
    });

    it('gives a click on a CloudTAK feature to CloudTAK', async () => {
        const { mapStore } = setup();
        rendered = [feature(COT_LAYER, 'alpha')];

        await mapStore.onMapClick(click());

        expect(mapStore.radial.mode).toBe('cot');
        expect(pluginClick).not.toHaveBeenCalled();
    });

    it('gives a click to the plugin when its feature is drawn above a CloudTAK feature', async () => {
        const { mapStore } = setup();
        rendered = [feature(PLUGIN_LAYER, 'rockwall'), feature(COT_LAYER, 'alpha')];

        await mapStore.onMapClick(click());

        expect(pluginClick).toHaveBeenCalledTimes(1);
        expect(mapStore.radial.mode).toBeUndefined();
        expect(mapStore.select.feats).toEqual([]);
    });

    it('gives a click to CloudTAK when its feature is drawn above a plugin feature', async () => {
        const { mapStore } = setup();
        rendered = [feature(COT_LAYER, 'alpha'), feature(PLUGIN_LAYER, 'rockwall')];

        await mapStore.onMapClick(click());

        expect(mapStore.radial.mode).toBe('cot');
        expect(pluginClick).not.toHaveBeenCalled();
    });

    it('looks past layers nobody claims to the topmost claimed feature', async () => {
        const { mapStore } = setup();
        rendered = [feature(UNCLAIMED_LAYER, 'rockwall-name'), feature(PLUGIN_LAYER, 'rockwall'), feature(COT_LAYER, 'alpha')];

        await mapStore.onMapClick(click());

        expect(pluginClick).toHaveBeenCalledTimes(1);
        expect(mapStore.radial.mode).toBeUndefined();
    });

    it('opens the multiple-feature picker with CloudTAK features only when CloudTAK owns the click', async () => {
        const { mapStore } = setup();
        rendered = [feature(COT_LAYER, 'alpha'), feature(PLUGIN_LAYER, 'rockwall'), feature(COT_LAYER, 'bravo')];

        await mapStore.onMapClick(click());

        expect(mapStore.select.feats).toEqual([{ id: 'alpha' }, { id: 'bravo' }]);
        expect(pluginClick).not.toHaveBeenCalled();
    });

    it('never calls the plugin while CloudTAK is drawing', async () => {
        const { mapStore, draw } = setup();
        draw.mode = DrawToolMode.POLYGON;
        rendered = [feature(PLUGIN_LAYER, 'rockwall')];

        await mapStore.onMapClick(click());

        expect(pluginClick).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
    });

    it('never calls the plugin while CloudTAK is editing a feature', async () => {
        const { mapStore, draw } = setup();
        (draw as { editing: unknown }).editing = { id: 'alpha' };
        rendered = [feature(PLUGIN_LAYER, 'rockwall')];

        await mapStore.onMapClick(click());

        expect(pluginClick).not.toHaveBeenCalled();
    });

    it('lets a click that closes the radial menu do nothing else', async () => {
        const { mapStore } = setup();
        mapStore.radial.mode = 'cot';
        rendered = [feature(PLUGIN_LAYER, 'rockwall')];

        await mapStore.onMapClick(click());

        expect(mapStore.radial.mode).toBeUndefined();
        expect(pluginClick).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
    });

    it('lets a search box location pick own the click, and gives the next click to the plugin', async () => {
        const { mapStore } = setup();
        const start = routeEndpoint();
        rendered = [feature(PLUGIN_LAYER, 'rockwall')];

        await start.find('.location-picker-btn').trigger('click');
        await mapClick(mapStore);
        expect(start.emitted('select')).toHaveLength(1);
        expect(pluginClick).not.toHaveBeenCalled();

        await mapClick(mapStore);
        expect(pluginClick).toHaveBeenCalledTimes(1);
    });

    it('keeps the plugin off while one of two route endpoint picks is still pending', async () => {
        const { mapStore } = setup();
        const start = routeEndpoint();
        const end = routeEndpoint();
        rendered = [feature(PLUGIN_LAYER, 'rockwall')];

        await start.find('.location-picker-btn').trigger('click');
        await end.find('.location-picker-btn').trigger('click');
        await end.find('.location-picker-btn').trigger('click');

        await mapClick(mapStore);
        expect(start.emitted('select')).toHaveLength(1);
        expect(end.emitted('select')).toBeUndefined();
        expect(pluginClick).not.toHaveBeenCalled();

        await mapClick(mapStore);
        expect(pluginClick).toHaveBeenCalledTimes(1);
    });

    it('keeps the plugin off while a pick is pending after another search box unmounts mid-pick', async () => {
        const { mapStore } = setup();
        const start = routeEndpoint();
        const end = routeEndpoint();
        rendered = [feature(PLUGIN_LAYER, 'rockwall')];

        await start.find('.location-picker-btn').trigger('click');
        await end.find('.location-picker-btn').trigger('click');
        end.unmount();

        await mapClick(mapStore);
        expect(start.emitted('select')).toHaveLength(1);
        expect(pluginClick).not.toHaveBeenCalled();

        start.unmount();
        await mapClick(mapStore);
        expect(pluginClick).toHaveBeenCalledTimes(1);
    });

    it('passes a click on a history point whose row is gone to the CloudTAK feature beneath', async () => {
        const { mapStore } = setup();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        Object.assign(mapStore._map as object, {
            getSource: () => undefined,
            addSource: vi.fn(),
            getLayer: () => undefined,
            addLayer: vi.fn(),
            on: vi.fn(),
            getLayersOrder: () => [],
        });
        new HistoryLayer(mapStore).init();
        rendered = [feature(HISTORY_POINT_LAYER, 'alpha@2026-11-27T00:00:00.000Z'), feature(COT_LAYER, 'alpha')];

        await mapStore.onMapClick(click());

        expect(mapStore.radial.mode).toBe('cot');
    });

    it('lets a click that dismisses the multiple-feature picker do nothing else, and gives the next click to the plugin', async () => {
        const { mapStore } = setup();
        rendered = [feature(COT_LAYER, 'alpha'), feature(COT_LAYER, 'bravo')];
        await mapStore.onMapClick(click());
        expect(mapStore.select.feats).toHaveLength(2);

        rendered = [feature(PLUGIN_LAYER, 'rockwall')];
        await mapStore.onMapClick(click());
        expect(mapStore.select.feats).toEqual([]);
        expect(pluginClick).not.toHaveBeenCalled();

        await mapStore.onMapClick(click());
        expect(pluginClick).toHaveBeenCalledTimes(1);
    });

    it('keeps a Ctrl-click on a CloudTAK feature from the plugin while the lookup is slow', async () => {
        const { mapStore } = setup();
        let release = () => {};
        lookup = (id) => new Promise((r) => { release = () => r({ id }); });
        rendered = [feature(COT_LAYER, 'alpha'), feature(PLUGIN_LAYER, 'rockwall')];

        const done = mapStore.onMapClick(click({ ctrlKey: true }));
        await new Promise((r) => setTimeout(r, 120));
        expect(pluginClick).not.toHaveBeenCalled();

        release();
        await done;
        expect(mapStore.selected.has('alpha')).toBe(true);
        expect(pluginClick).not.toHaveBeenCalled();
    });

    it('gives a Ctrl-click on a plugin feature to the plugin without a lookup', async () => {
        const { mapStore } = setup();
        lookup = vi.fn(async (id: string) => ({ id }));
        rendered = [feature(PLUGIN_LAYER, 'rockwall'), feature(COT_LAYER, 'alpha')];

        const done = mapStore.onMapClick(click({ ctrlKey: true }));
        expect(pluginClick).toHaveBeenCalledTimes(1);
        await done;

        expect(lookup).not.toHaveBeenCalled();
        expect(mapStore.selected.size).toBe(0);
    });

    it('stops calling a plugin once it disposes of its claim', async () => {
        const { mapStore, dispose } = setup();
        dispose();
        rendered = [feature(PLUGIN_LAYER, 'rockwall')];

        await mapStore.onMapClick(click());

        expect(pluginClick).not.toHaveBeenCalled();
    });

    it('keeps a newer claim on the layer when an older claim is disposed of', async () => {
        const { mapStore, dispose } = setup();
        const newer = vi.fn();
        plugin().click.add(PLUGIN_LAYER, newer);
        dispose();
        rendered = [feature(PLUGIN_LAYER, 'rockwall')];

        await mapStore.onMapClick(click());

        expect(newer).toHaveBeenCalledTimes(1);
        expect(pluginClick).not.toHaveBeenCalled();
    });
});
