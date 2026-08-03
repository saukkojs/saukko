import assert from 'node:assert/strict';
import test from 'node:test';
import type { Container } from '../src/container';
import type { ConfigService } from '../src/services/config';
import type { LoggerService } from '../src/services/logger';
import { PluginService } from '../src/services/plugin';

test('removing an enabled plugin waits for its lifecycle cleanup', async () => {
    const stopped: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
    });
    const service = new PluginService(
        { has: () => true, get: () => undefined } as unknown as Container,
        { log: () => {} } as unknown as LoggerService,
        { get: () => undefined } as unknown as ConfigService,
    );

    service.install({
        name: 'removable',
        default: (context) => {
            context.lifecycle.onStop(async () => {
                stopped.push('stopping');
                await cleanupGate;
                stopped.push('stopped');
            });
        },
    });
    await service.apply('removable');

    const removing = service.remove('removable');
    let removed = false;
    void removing.then(() => {
        removed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(stopped, ['stopping']);
    assert.equal(removed, false);

    releaseCleanup();
    await removing;

    assert.deepEqual(stopped, ['stopping', 'stopped']);
    assert.equal(service.map().has('removable'), false);
});
