import assert from 'node:assert/strict';
import test from 'node:test';
import type { Container } from '../src/container';
import type { ConfigService } from '../src/services/config';
import type { LoggerService } from '../src/services/logger';
import { PluginService } from '../src/services/plugin';

function createPluginService() {
    return new PluginService(
        { has: () => true, get: () => undefined } as unknown as Container,
        { log: () => {} } as unknown as LoggerService,
        { get: () => undefined } as unknown as ConfigService,
    );
}

test('removing an enabled plugin waits for its lifecycle cleanup', async () => {
    const stopped: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
    });
    const service = createPluginService();

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

test('a failed plugin apply cleans up its context and can be retried', async () => {
    const service = createPluginService();
    const cleanups: string[] = [];
    let attempts = 0;

    service.install({
        name: 'retryable',
        default: (context) => {
            attempts += 1;
            context.lifecycle.onStop(() => {
                cleanups.push(`cleanup-${attempts}`);
            });
            if (attempts === 1) throw new Error('apply failed');
        },
    });

    await assert.rejects(service.apply('retryable'), /apply failed/);
    assert.deepEqual(cleanups, ['cleanup-1']);
    assert.equal(service.map().get('retryable')?.enabled, false);

    await service.apply('retryable');
    assert.equal(service.map().get('retryable')?.enabled, true);

    await service.dispose('retryable');
    assert.deepEqual(cleanups, ['cleanup-1', 'cleanup-2']);
});

test('a failed uninstall keeps a disabled plugin available for a retry', async () => {
    const service = createPluginService();
    let cleanupAttempts = 0;

    service.install({
        name: 'failing-cleanup',
        default: (context) => {
            context.lifecycle.onStop(() => {
                cleanupAttempts += 1;
                throw new Error('cleanup failed');
            });
        },
    });
    await service.apply('failing-cleanup');

    await assert.rejects(service.remove('failing-cleanup'), /cleanup failed/);
    assert.equal(service.map().get('failing-cleanup')?.enabled, false);
    assert.equal(cleanupAttempts, 1);

    await service.remove('failing-cleanup');
    assert.equal(service.map().has('failing-cleanup'), false);
    assert.equal(cleanupAttempts, 1);
});
