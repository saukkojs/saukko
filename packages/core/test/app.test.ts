import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from '../src/app';
import type { Container } from '../src/container';
import type { LoggerService } from '../src/services/logger';
import type { PluginService } from '../src/services/plugin';

test('App stops every enabled plugin when one plugin cleanup fails', async () => {
    const stopped: string[] = [];
    const logs: unknown[][] = [];
    const plugin = {
        map: () => new Map([
            ['broken', { enabled: true }],
            ['healthy', { enabled: true }],
        ]),
        dispose: async (name: string) => {
            stopped.push(name);
            if (name === 'broken') throw new Error('broken cleanup');
        },
    } as unknown as PluginService;
    const logger = {
        log: (...args: unknown[]) => logs.push(args),
    } as unknown as LoggerService;
    const app = new App(logger, {} as Container, plugin);

    await assert.rejects(app.stop(), /broken cleanup/);

    assert.deepEqual(stopped, ['broken', 'healthy']);
    assert.equal(logs.at(-1)?.[2], 'App stopped.');
});
