import assert from 'node:assert/strict';
import test from 'node:test';
import { LifecycleState } from '../src/lifecycle';
import { createContainerScope, createScope } from '../src/scope';

test('child scope reads fall back to the parent chain', () => {
    const root = createScope();
    root.set('shared', 'root-value');
    const child = root.fork();

    assert.equal(child.get('shared'), 'root-value');
    assert.equal(child.has('shared'), true);
    assert.equal(child.get('missing'), undefined);
    assert.equal(child.has('missing'), false);
});

test('child scope registrations belong to the child and shadow without polluting the parent', () => {
    const root = createScope();
    root.set('shared', 'root-value');
    const child = root.fork();
    child.set('shared', 'child-value');
    child.set('own', 42);

    assert.equal(child.get('shared'), 'child-value');
    assert.equal(root.get('shared'), 'root-value');
    assert.equal(root.has('own'), false);
});

test('disposing a scope disposes children in reverse creation order before its own cleanup', async () => {
    const root = createScope();
    const order: string[] = [];
    const first = root.fork();
    const second = root.fork();
    first.lifecycle.onStop(() => {
        order.push('first');
    });
    second.lifecycle.onStop(() => {
        order.push('second');
    });
    root.lifecycle.onStop(() => {
        order.push('root');
    });

    await root.dispose();

    assert.deepEqual(order, ['second', 'first', 'root']);
    assert.equal(first.lifecycle.state, LifecycleState.STOPPED);
    assert.equal(second.lifecycle.state, LifecycleState.STOPPED);
    assert.equal(root.lifecycle.state, LifecycleState.STOPPED);
});

test('dispose is idempotent and concurrent calls share the same task', async () => {
    const root = createScope();
    let cleanups = 0;
    root.lifecycle.onStop(() => {
        cleanups += 1;
    });

    const first = root.dispose();
    const second = root.dispose();
    assert.equal(first, second);
    await Promise.all([first, second]);
    await root.dispose();

    assert.equal(cleanups, 1);
});

test('a disposed scope detaches from its parent and rejects further writes', async () => {
    const root = createScope();
    root.set('shared', 'root-value');
    const child = root.fork();
    child.set('own', 42);

    await child.dispose();

    assert.equal(child.parent, undefined);
    assert.throws(() => child.set('late', 1), /disposed/);
    assert.throws(() => child.fork(), /disposed/);

    // 父作用域不受子作用域销毁影响，仍可正常读写与派生。
    assert.equal(root.get('shared'), 'root-value');
    const sibling = root.fork();
    assert.equal(sibling.get('shared'), 'root-value');
});

test('a failing child cleanup does not block the rest of the disposal and is aggregated', async () => {
    const root = createScope();
    const order: string[] = [];
    const broken = root.fork();
    const healthy = root.fork();
    broken.lifecycle.onStop(() => {
        order.push('broken');
        throw new Error('broken cleanup');
    });
    healthy.lifecycle.onStop(() => {
        order.push('healthy');
    });
    root.lifecycle.onStop(() => {
        order.push('root');
    });

    await assert.rejects(root.dispose(), /broken cleanup/);
    assert.deepEqual(order, ['healthy', 'broken', 'root']);
});

test('createScope rejects a foreign parent implementation', () => {
    const foreign = {
        parent: undefined,
        lifecycle: undefined,
        has: () => false,
        get: () => undefined,
        set: () => {},
        fork: () => foreign,
        dispose: async () => {},
    };
    assert.throws(() => createScope(foreign as never), /createScope/);
});

test('provided services start with the scope lifecycle and stop in reverse registration order', async () => {
    const root = createScope();
    const calls: string[] = [];
    const make = (name: string) => ({
        start: async () => {
            calls.push(`start-${name}`);
        },
        stop: async () => {
            calls.push(`stop-${name}`);
        },
    });

    await root.provide('first', make('first'));
    await root.provide('second', make('second'));
    assert.deepEqual(calls, []);

    await root.lifecycle.start();
    assert.deepEqual(calls, ['start-first', 'start-second']);

    await root.dispose();
    assert.deepEqual(calls, ['start-first', 'start-second', 'stop-second', 'stop-first']);
});

test('providing a service on an active scope starts it immediately and awaits completion', async () => {
    const root = createScope();
    await root.lifecycle.start();

    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseStart = resolve;
    });
    const calls: string[] = [];
    const service = {
        start: async () => {
            calls.push('starting');
            await gate;
            calls.push('started');
        },
        stop: async () => {
            calls.push('stopped');
        },
    };

    const provided = root.provide('late', service);
    let resolved = false;
    void provided.then(() => {
        resolved = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['starting']);
    assert.equal(resolved, false);

    releaseStart();
    assert.equal(await provided, service);
    assert.deepEqual(calls, ['starting', 'started']);

    await root.dispose();
    assert.deepEqual(calls, ['starting', 'started', 'stopped']);
});

test('a service whose start fails does not receive stop, earlier services still stop', async () => {
    const root = createScope();
    const calls: string[] = [];

    await root.provide('healthy', {
        start: async () => {
            calls.push('start-healthy');
        },
        stop: async () => {
            calls.push('stop-healthy');
        },
    });
    await root.provide('broken', {
        start: async () => {
            calls.push('start-broken');
            throw new Error('start failed');
        },
        stop: async () => {
            calls.push('stop-broken');
        },
    });

    await assert.rejects(root.lifecycle.start(), /start failed/);
    assert.deepEqual(calls, ['start-healthy', 'start-broken', 'stop-healthy']);
});

test('a stop-only service is stopped even if the scope never started', async () => {
    const root = createScope();
    const calls: string[] = [];
    await root.provide('stop-only', {
        stop: async () => {
            calls.push('stopped');
        },
    });

    await root.dispose();
    assert.deepEqual(calls, ['stopped']);
});

test('providing a service while the scope lifecycle is starting is rejected', async () => {
    const root = createScope();
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseStart = resolve;
    });
    root.lifecycle.onStart(async () => {
        await gate;
    });
    const starting = root.lifecycle.start();

    await assert.rejects(root.provide('late', {}), /Cannot provide a service/);

    releaseStart();
    await starting;
    await root.dispose();
});

test('container-backed scope falls back to the container and lets scope registrations shadow it', () => {
    const containerService = { kind: 'container' };
    const container = {
        has: (name: string) => name === 'svc',
        get: (name: string) => (name === 'svc' ? containerService : undefined),
        list: () => ['svc'],
    };
    const root = createContainerScope(container);

    assert.equal(root.get('svc'), containerService);
    assert.equal(root.has('svc'), true);
    assert.equal(root.has('missing'), false);

    // 子作用域沿父链直达容器服务。
    const child = root.fork();
    assert.equal(child.get('svc'), containerService);

    // 作用域登记按常规遮蔽规则覆盖容器值，容器本身不受影响。
    const shadow = { kind: 'shadow' };
    child.set('svc', shadow);
    assert.equal(child.get('svc'), shadow);
    assert.equal(root.get('svc'), containerService);
});

test('register instantiates lazily, caches, and resolves inject via the parent chain', () => {
    const root = createScope();
    root.set('greeting', 'hello');
    let constructions = 0;

    class Greeter {
        static inject = ['greeting'] as const;
        constructor(public greeting: string) {
            constructions += 1;
        }
    }

    const child = root.fork();
    child.register('greeter', Greeter);

    // 惰性：注册时不实例化；依赖沿父链解析。
    assert.equal(constructions, 0);
    const first = child.get<Greeter>('greeter')!;
    assert.equal(first.greeting, 'hello');
    assert.equal(constructions, 1);
    // 缓存：再次读取返回同一实例。
    assert.equal(child.get('greeter'), first);
    assert.equal(constructions, 1);
    // 父作用域看不到子作用域注册的服务。
    assert.equal(root.has('greeter'), false);
});

test('register detects circular dependencies within the same scope', () => {
    const root = createScope();
    root.register('a', () => root.get('a'));
    assert.throws(() => root.get('a'), /Circular dependency detected: a/);
});

test('list merges own registrations, ancestors and the container fallback', () => {
    const container = {
        has: () => false,
        get: () => undefined,
        list: () => ['from-container'],
    };
    const root = createContainerScope(container);
    root.set('from-root', 1);
    const child = root.fork();
    child.register('from-child', () => ({}));

    assert.deepEqual(child.list().sort(), ['from-child', 'from-container', 'from-root']);
    assert.deepEqual(root.list().sort(), ['from-container', 'from-root']);
});

test('register on a disposed scope is rejected', async () => {
    const root = createScope();
    await root.dispose();
    assert.throws(() => root.register('late', () => ({})), /disposed/);
});
