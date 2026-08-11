import assert from 'node:assert/strict';
import test from 'node:test';
import { Lifecycle, LifecycleState } from '../src/lifecycle';
import { createScope } from '../src/scope';
import { PluginContext } from '../src/services/plugin/context';

declare module '../src/services/plugin/types' {
    interface Events {
        'test.event': { value: string };
    }
}

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

test('stops after startup when stop is requested while starting', async () => {
    const lifecycle = new Lifecycle();
    const calls: string[] = [];
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
    });

    lifecycle.onStart(async () => {
        calls.push('start');
        await startGate;
        return () => {
            calls.push('stop');
        };
    });

    const starting = lifecycle.start();
    const stopping = lifecycle.stop();
    releaseStart();

    await Promise.all([starting, stopping]);

    assert.deepEqual(calls, ['start', 'stop']);
    assert.equal(lifecycle.state, LifecycleState.STOPPED);
});

test('does not accept new stop handlers while stopping', async () => {
    const lifecycle = new Lifecycle();
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
    });

    lifecycle.onStop(async () => {
        await cleanupGate;
    });
    await lifecycle.start();
    const stopping = lifecycle.stop();

    assert.throws(() => lifecycle.onStop(() => {}), /stopping/);
    assert.throws(() => lifecycle.onBeforeStop(() => {}), /stopping/);

    releaseCleanup();
    await stopping;
});

test('PluginContext removes its business event listeners during disposal', async () => {
    const sharedEvents = new Map();
    const context = new PluginContext(createScope(), {}, new Map(), [], sharedEvents);
    const calls: string[] = [];

    context.on('test.event', () => {
        calls.push('event');
    });

    await context.start();
    context.emit('test.event', { name: 'test.event', data: { value: 'first' } });
    await context.dispose();
    const sibling = new PluginContext(createScope(), {}, new Map(), [], sharedEvents);
    sibling.emit('test.event', { name: 'test.event', data: { value: 'second' } });

    assert.deepEqual(calls, ['event']);
    assert.equal(context.lifecycle.state, LifecycleState.DISPOSED);
});

test('PluginContext dispatches business events synchronously', async () => {
    const context = new PluginContext(createScope(), {}, new Map(), [], new Map());
    const calls: string[] = [];

    context.on('test.event', () => {
        calls.push('event');
    });

    // 事件分发受属主生命周期门控：仅 ACTIVE 状态接收。
    context.emit('test.event', { name: 'test.event', data: { value: 'pending' } });
    assert.deepEqual(calls, []);

    await context.start();
    const result = context.emit('test.event', { name: 'test.event', data: { value: 'test' } });
    assert.deepEqual(calls, ['event']);
    assert.equal(result, undefined);
});

test('hooks persist across stop and the lifecycle can be restarted', async () => {
    const lifecycle = new Lifecycle();
    const calls: string[] = [];

    lifecycle.onStart(() => {
        calls.push('start');
    });
    lifecycle.onStop(() => {
        calls.push('stop');
    });

    await lifecycle.start();
    await lifecycle.stop();
    assert.equal(lifecycle.state, LifecycleState.STOPPED);

    await lifecycle.start();
    assert.equal(lifecycle.state, LifecycleState.ACTIVE);
    await lifecycle.stop();

    assert.deepEqual(calls, ['start', 'stop', 'start', 'stop']);
});

test('cleanups returned by onStart run once per start cycle', async () => {
    const lifecycle = new Lifecycle();
    const calls: string[] = [];
    let cycle = 0;

    lifecycle.onStart(() => {
        cycle += 1;
        const current = cycle;
        calls.push(`start-${current}`);
        return () => {
            calls.push(`cleanup-${current}`);
        };
    });

    await lifecycle.start();
    await lifecycle.stop();
    await lifecycle.start();
    await lifecycle.stop();

    // 上一周期的清理不重复执行。
    assert.deepEqual(calls, ['start-1', 'cleanup-1', 'start-2', 'cleanup-2']);
});

test('dispose is terminal and rejects further operations', async () => {
    const lifecycle = new Lifecycle();
    const calls: string[] = [];
    lifecycle.onStop(() => {
        calls.push('stop');
    });

    await lifecycle.start();
    await lifecycle.dispose();
    assert.equal(lifecycle.state, LifecycleState.DISPOSED);
    assert.deepEqual(calls, ['stop']);

    assert.throws(() => lifecycle.start(), /disposed/);
    assert.throws(() => lifecycle.onStart(() => {}), /disposed/);
    assert.throws(() => lifecycle.onStop(() => {}), /disposed/);
    // 幂等：重复 dispose 共享同一任务，清理不重复执行。
    await lifecycle.dispose();
    await lifecycle.stop();
    assert.deepEqual(calls, ['stop']);
});

test('onDispose hooks run once in reverse registration order at terminal disposal', async () => {
    const lifecycle = new Lifecycle();
    const calls: string[] = [];
    lifecycle.onDispose(() => {
        calls.push('first');
    });
    lifecycle.onDispose(() => {
        calls.push('second');
    });

    await lifecycle.start();
    await lifecycle.dispose();

    assert.deepEqual(calls, ['second', 'first']);
    assert.equal(lifecycle.state, LifecycleState.DISPOSED);
    assert.throws(() => lifecycle.onDispose(() => {}), /disposed/);

    // 幂等：重复 dispose 不重跑销毁钩子。
    await lifecycle.dispose();
    assert.deepEqual(calls, ['second', 'first']);
});

test('a failed start can be retried', async () => {
    const lifecycle = new Lifecycle();
    let attempts = 0;
    lifecycle.onStart(() => {
        attempts += 1;
        if (attempts === 1) throw new Error('startup failed');
    });

    await assert.rejects(lifecycle.start(), /startup failed/);
    assert.equal(lifecycle.state, LifecycleState.FAILED);

    await lifecycle.start();
    assert.equal(lifecycle.state, LifecycleState.ACTIVE);
    assert.equal(attempts, 2);
});
