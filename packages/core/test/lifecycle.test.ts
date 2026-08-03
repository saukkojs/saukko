import assert from 'node:assert/strict';
import test from 'node:test';
import { Lifecycle, LifecycleState } from '../src/lifecycle';
import { PluginContext } from '../src/services/plugin/context';

test('becomes active only after asynchronous startup completes', async () => {
    const lifecycle = new Lifecycle();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
    });

    lifecycle.onStart(async () => {
        await startGate;
    });

    const starting = lifecycle.start();
    assert.equal(lifecycle.state, LifecycleState.STARTING);

    releaseStart();
    await starting;

    assert.equal(lifecycle.state, LifecycleState.ACTIVE);
});

test('waits for cleanup handlers in reverse registration order', async () => {
    const lifecycle = new Lifecycle();
    const calls: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
    });

    lifecycle.onStop(() => {
        calls.push('first');
    });
    lifecycle.onStop(async () => {
        calls.push('second');
        await cleanupGate;
        calls.push('second-complete');
    });

    await lifecycle.start();
    const stopping = lifecycle.stop();

    assert.equal(lifecycle.state, LifecycleState.STOPPING);
    assert.deepEqual(calls, ['second']);

    releaseCleanup();
    await stopping;

    assert.deepEqual(calls, ['second', 'second-complete', 'first']);
    assert.equal(lifecycle.state, LifecycleState.STOPPED);
});

test('cleans up already-started resources when startup fails', async () => {
    const lifecycle = new Lifecycle();
    const calls: string[] = [];

    lifecycle.onStart(() => {
        calls.push('started');
        return () => {
            calls.push('cleaned');
        };
    });
    lifecycle.onStart(() => {
        throw new Error('startup failed');
    });

    await assert.rejects(lifecycle.start(), /startup failed/);

    assert.deepEqual(calls, ['started', 'cleaned']);
    assert.equal(lifecycle.state, LifecycleState.FAILED);
});

test('PluginContext emits lifecycle events before it removes plugin listeners', async () => {
    const context = new PluginContext({}, new Map(), [], new Map());
    const calls: string[] = [];

    context.on('internal.ready', () => {
        calls.push('ready');
    });
    context.on('internal.dispose', () => {
        calls.push('dispose');
    });
    context.on('custom.event' as never, () => {
        calls.push('custom');
    });

    await context.start();
    await context.dispose();
    context.emit('custom.event' as never, {} as never);

    assert.deepEqual(calls, ['ready', 'dispose']);
    assert.equal(context.lifecycle.state, LifecycleState.STOPPED);
});
