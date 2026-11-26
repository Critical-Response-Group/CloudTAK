import test from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import { Pool } from '@openaddresses/batch-generic';
import ProfileConfigModel from '../common/models/ProfileConfig.js';
import * as pgtypes from '../common/schema.js';
import Flight from './flight.js';

const flight = new Flight();

flight.init({ takserver: true });
flight.takeoff();
flight.user();
flight.user({ username: 'user', admin: false });
flight.user({ username: 'firstrun', admin: false });
flight.server('admin@example.com', 'password123');

let session: string;
let token: string;

test('PATCH: api/profile - plugin_settings merges keys and an empty string removes one', async () => {
    try {
        const login = await flight.fetch('/api/login', {
            method: 'POST',
            body: { username: 'user@example.com', password: 'password123' },
        }, true);

        session = login.body.session;
        token = login.body.token;

        const first = await flight.fetch('/api/profile', {
            method: 'PATCH',
            auth: { bearer: token },
            body: { plugin_settings: { 'crg-map-layers': 'crg-authkey' } },
        }, true);

        assert.deepEqual(first.body.plugin_settings, { 'crg-map-layers': 'crg-authkey' });

        const second = await flight.fetch('/api/profile', {
            method: 'PATCH',
            auth: { bearer: token },
            body: { plugin_settings: { other: 'value' } },
        }, true);

        assert.deepEqual(second.body.plugin_settings, { 'crg-map-layers': 'crg-authkey', other: 'value' });

        const removed = await flight.fetch('/api/profile', {
            method: 'PATCH',
            auth: { bearer: token },
            body: { plugin_settings: { other: '' } },
        }, true);

        assert.deepEqual(removed.body.plugin_settings, { 'crg-map-layers': 'crg-authkey' });
    } catch (err) {
        assert.ifError(err);
    }
});

test('PATCH: api/profile - concurrent plugin_settings writes from two sessions keep every key', async () => {
    try {
        const other = await flight.fetch('/api/login', {
            method: 'POST',
            body: { username: 'user@example.com', password: 'password123' },
        }, true);

        const keys = Array.from({ length: 10 }, (_, i) => `concurrent-${i}`);

        await Promise.all(keys.map((key, i) => flight.fetch('/api/profile', {
            method: 'PATCH',
            auth: { bearer: i % 2 ? other.body.token : token },
            body: { plugin_settings: { [key]: 'value' } },
        }, true)));

        const res = await flight.fetch('/api/profile', {
            method: 'GET',
            auth: { bearer: token },
        }, true);

        assert.deepEqual(Object.keys(res.body.plugin_settings).sort(), ['crg-map-layers', ...keys].sort());

        await flight.fetch('/api/profile', {
            method: 'PATCH',
            auth: { bearer: token },
            body: { plugin_settings: Object.fromEntries(keys.map((key) => [key, ''])) },
        }, true);
    } catch (err) {
        assert.ifError(err);
    }
});

test('ProfileConfig.commit - writes naming plugin::settings and another key in opposite orders do not deadlock', async () => {
    const connstr = new URL(flight.connstr!);
    connstr.searchParams.delete('max');
    const pool = await Pool.connect(connstr.toString(), pgtypes);
    const model = new ProfileConfigModel(pool);
    const sql = postgres(flight.connstr!, { max: 2, onnotice: () => {} });
    const holder = await sql.reserve();

    try {
        await holder`BEGIN`;
        await holder`SELECT 1 FROM profile_settings WHERE username = 'user@example.com' AND key = 'plugin::settings' FOR UPDATE`;

        const advisory = async (granted: boolean) => {
            for (let i = 0; i < 100; i++) {
                const [{ count }] = await sql`
                    SELECT count(*)::int AS count
                        FROM pg_locks
                        WHERE locktype = 'advisory'
                            AND granted = ${granted}
                            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                            AND objid::bigint = (hashtext(${'profile::settings:user@example.com'}::text)::bigint & 4294967295)
                `;
                if (count > 0) return;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error('Advisory lock never reached');
        };

        const first = model.commit('user@example.com', { 'plugin::settings': { mixed: 'first' }, 'tak::remarks': 'First' });
        await advisory(true);

        const second = model.commit('user@example.com', { 'tak::remarks': 'Second', 'plugin::settings': { mixed: 'second' } });
        await advisory(false);

        await holder`ROLLBACK`;

        const results = await Promise.allSettled([first, second]);
        assert.deepEqual(results.map((result) => result.status === 'rejected' ? String(result.reason.cause ?? result.reason) : result.status), ['fulfilled', 'fulfilled']);

        await model.commit('user@example.com', { 'plugin::settings': { mixed: '' } });
    } catch (err) {
        assert.ifError(err);
    } finally {
        await holder`ROLLBACK`;
        holder.release();
        await sql.end();
        pool.end();
    }
});

test('PATCH: api/profile - a plugin_settings write leaves a new user on first run', async () => {
    try {
        const before = await flight.fetch('/api/profile', {
            method: 'GET',
            auth: { bearer: flight.token.firstrun },
        }, true);

        assert.equal(before.body.updated, before.body.created);

        await flight.fetch('/api/profile', {
            method: 'PATCH',
            auth: { bearer: flight.token.firstrun },
            body: { plugin_settings: { 'crg-map-layers': 'crg-authkey' } },
        }, true);

        const after = await flight.fetch('/api/profile', {
            method: 'GET',
            auth: { bearer: flight.token.firstrun },
        }, true);

        assert.equal(after.body.updated, after.body.created);

        const configured = await flight.fetch('/api/profile', {
            method: 'PATCH',
            auth: { bearer: flight.token.firstrun },
            body: { tak_callsign: 'Configured' },
        }, true);

        assert.notEqual(configured.body.updated, configured.body.created);
    } catch (err) {
        assert.ifError(err);
    }
});

test('PATCH: api/profile - a failed write saves no plugin_settings', async () => {
    try {
        const res = await flight.fetch('/api/profile', {
            method: 'PATCH',
            auth: { bearer: token },
            body: { plugin_settings: { partial: 'value' }, tak_remarks: 'nul \u0000 byte' },
        }, false);

        assert.notEqual(res.status, 200);

        const profile = await flight.fetch('/api/profile', {
            method: 'GET',
            auth: { bearer: token },
        }, true);

        assert.deepEqual(profile.body.plugin_settings, { 'crg-map-layers': 'crg-authkey' });
    } catch (err) {
        assert.ifError(err);
    }
});

test('GET & PATCH: api/user/user@example.com - an admin does not see plugin_settings', async () => {
    try {
        const get = await flight.fetch('/api/user/user@example.com', {
            method: 'GET',
            auth: { bearer: flight.token.admin },
        }, true);

        assert.equal(get.body.username, 'user@example.com');
        assert.equal('plugin_settings' in get.body, false);

        const patch = await flight.fetch('/api/user/user@example.com', {
            method: 'PATCH',
            auth: { bearer: flight.token.admin },
            body: { tak_remarks: 'Admin Remarks' },
        }, true);

        assert.equal(patch.body.tak_remarks, 'Admin Remarks');
        assert.equal('plugin_settings' in patch.body, false);
    } catch (err) {
        assert.ifError(err);
    }
});

test('PATCH: api/profile - plugin_settings rejects an invalid plugin key', async () => {
    try {
        const res = await flight.fetch('/api/profile', {
            method: 'PATCH',
            auth: { bearer: token },
            body: { plugin_settings: { 'not a key': 'value' } },
        }, false);

        assert.equal(res.status, 400);
    } catch (err) {
        assert.ifError(err);
    }
});

test('PATCH: api/profile - plugin_settings rejects __proto__ as a plugin key', async () => {
    try {
        const res = await flight.fetch('/api/profile', {
            method: 'PATCH',
            auth: { bearer: token },
            body: JSON.parse('{"plugin_settings":{"__proto__":"synthetic-value"}}'),
        }, false);

        assert.equal(res.status, 400);

        const stored = await flight.config!.models.ProfileConfig.from('user@example.com');
        assert.equal(Object.hasOwn(stored['plugin::settings'] as object, '__proto__'), false);
    } catch (err) {
        assert.ifError(err);
    }
});

test('GET: api/profile - plugin_settings survive logout and reach a second session', async () => {
    try {
        const logout = await flight.fetch(`/api/user/user@example.com/session/${session}`, {
            method: 'DELETE',
            auth: { bearer: token },
        }, false);

        assert.equal(logout.status, 200);

        const revoked = await flight.fetch('/api/profile', {
            method: 'GET',
            auth: { bearer: token },
        }, false);

        assert.equal(revoked.status, 401);

        const login = await flight.fetch('/api/login', {
            method: 'POST',
            body: { username: 'user@example.com', password: 'password123' },
        }, true);

        assert.notEqual(login.body.session, session);

        const res = await flight.fetch('/api/profile', {
            method: 'GET',
            auth: { bearer: login.body.token },
        }, true);

        assert.deepEqual(res.body.plugin_settings, { 'crg-map-layers': 'crg-authkey' });
    } catch (err) {
        assert.ifError(err);
    }
});

flight.landing();
