import test from 'node:test';
import assert from 'node:assert';
import Flight from './flight.js';

const flight = new Flight();

flight.init({ takserver: true });
flight.takeoff();
flight.user();
flight.user({ username: 'user', admin: false });
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
