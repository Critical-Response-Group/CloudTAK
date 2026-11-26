import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn() }));
vi.mock('../std.ts', () => ({ server }));

import ProfileConfig from '../base/profile.ts';
import { db } from '../database.ts';

describe('ProfileConfig', () => {
    beforeEach(async () => {
        server.GET.mockReset();
        server.PATCH.mockReset();
        await db.profile.clear();
    });

    it('keeps a setting committed while an older profile refresh is in flight', async () => {
        await db.profile.put({ key: 'tak_callsign', value: 'Old' });

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        server.GET.mockImplementation(async () => {
            const snapshot = { tak_callsign: 'Old', tak_remarks: 'Fresh' };
            await gate;
            return { data: snapshot };
        });
        server.PATCH.mockResolvedValue({ data: {} });

        const refresh = ProfileConfig.sync({ refresh: true });
        await new ProfileConfig('tak_callsign', 'Old').commit('New');
        release();
        await refresh;

        expect((await ProfileConfig.get('tak_callsign'))?.value).toBe('New');
        expect((await ProfileConfig.get('tak_remarks'))?.value).toBe('Fresh');
    });

    it('keeps a setting when a refresh starts after the local write but before the server has it', async () => {
        await db.profile.put({ key: 'tak_callsign', value: 'Old' });

        let accept!: () => void;
        const accepted = new Promise<void>((resolve) => { accept = resolve; });
        server.PATCH.mockImplementation(async () => {
            await accepted;
            return { data: {} };
        });
        server.GET.mockResolvedValue({ data: { tak_callsign: 'Old' } });

        const commit = new ProfileConfig('tak_callsign', 'Old').commit('New');
        await vi.waitFor(() => expect(server.PATCH).toHaveBeenCalled());
        await ProfileConfig.sync({ refresh: true });
        accept();
        await commit;

        expect((await ProfileConfig.get('tak_callsign'))?.value).toBe('New');
    });
});
