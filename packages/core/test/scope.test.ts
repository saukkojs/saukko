import assert from 'node:assert/strict';
import test from 'node:test';
import { LifecycleState } from '../src/lifecycle';
import { createScope } from '../src/scope';
import type { LoggerService } from '../src/services/logger';

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
    assert.equal(first.lifecycle.state, LifecycleState.DISPOSED);
    assert.equal(second.lifecycle.state, LifecycleState.DISPOSED);
    assert.equal(root.lifecycle.state, LifecycleState.DISPOSED);
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

test('list merges own registrations and ancestors', () => {
    const root = createScope();
    root.set('from-root', 1);
    const child = root.fork();
    child.register('from-child', () => ({}));

    assert.deepEqual(child.list().sort(), ['from-child', 'from-root']);
    assert.deepEqual(root.list(), ['from-root']);
});

test('register on a disposed scope is rejected', async () => {
    const root = createScope();
    await root.dispose();
    assert.throws(() => root.register('late', () => ({})), /disposed/);
});

test('re-providing a service stops the old one and detaches its lifecycle hooks', async () => {
    const root = createScope();
    const events: string[] = [];
    const makeService = (tag: string) => ({
        start: () => { events.push(`start-${tag}`); },
        stop: () => { events.push(`stop-${tag}`); },
    });

    await root.lifecycle.start();
    await root.provide('svc', makeService('v1'));
    assert.deepEqual(events, ['start-v1']);

    // 覆盖：旧服务先停止，新服务立即启动。
    await root.provide('svc', makeService('v2'));
    assert.deepEqual(events, ['start-v1', 'stop-v1', 'start-v2']);

    // 作用域销毁：旧服务的钩子已摘除，不会重复 stop；仅新服务收到停止。
    await root.dispose();
    assert.deepEqual(events, ['start-v1', 'stop-v1', 'start-v2', 'stop-v2']);
});

test('onReplace listeners run in registration order and are awaited by provide', async () => {
    const root = createScope();
    const events: string[] = [];
    let releaseListener!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseListener = resolve;
    });

    await root.provide('svc', { v: 1 });
    root.onReplace('svc', async () => {
        events.push('listener-1-enter');
        await gate;
        events.push('listener-1-exit');
    });
    root.onReplace('svc', async () => {
        events.push('listener-2');
    });

    const providing = root.provide('svc', { v: 2 });
    let settled = false;
    void providing.then(() => {
        settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['listener-1-enter']);
    assert.equal(settled, false);

    releaseListener();
    await providing;
    assert.deepEqual(events, ['listener-1-enter', 'listener-1-exit', 'listener-2']);
    assert.equal(settled, true);
});

test('set and register overrides stay silent for onReplace listeners', async () => {
    const root = createScope();
    const calls: string[] = [];
    root.onReplace('svc', (name) => {
        calls.push(name);
    });

    root.set('svc', 1);
    root.set('svc', 2);
    root.register('svc', () => 3);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, []);
    await root.dispose();
});

test('a failing onReplace listener rejects the covering provide', async () => {
    const root = createScope();
    await root.provide('svc', { v: 1 });
    root.onReplace('svc', () => {
        throw new Error('linkage failed');
    });

    await assert.rejects(root.provide('svc', { v: 2 }), /linkage failed/);
    // 服务本身已完成替换，失败只来自联动侧。
    assert.deepEqual(root.get('svc'), { v: 2 });
    await root.dispose();
});

test('get preserves ServiceRegistry typing for known keys and falls back otherwise', () => {
    const root = createScope();
    // 编译期断言：命中注册表的键返回注册表类型，未命中需显式泛型。
    const logger: LoggerService | undefined = root.get('logger');
    const custom = root.get<number>('custom');
    const wrong: string | undefined = custom;
    assert.equal(logger, undefined);
    assert.equal(wrong, undefined);
});

test('onAdd listeners fire only when a name is newly provided and are awaited', async () => {
    const root = createScope();
    const calls: string[] = [];
    root.onAdd('svc', async (name) => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        calls.push(`add-${name}`);
    });
    root.onReplace('svc', (name) => {
        calls.push(`replace-${name}`);
    });

    // set/register 保持纯登记语义，不触发联动。
    root.set('other', 1);
    root.register('lazy', () => ({}));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, []);

    // 新增登记触发 onAdd，且 provide 等待监听器完成。
    await root.provide('svc', { v: 1 });
    assert.deepEqual(calls, ['add-svc']);

    // 覆盖已有登记走 onReplace 而非 onAdd。
    await root.provide('svc', { v: 2 });
    assert.deepEqual(calls, ['add-svc', 'replace-svc']);

    await root.dispose();
});

test('a failing onAdd listener rejects the provide call', async () => {
    const root = createScope();
    root.onAdd('svc', () => {
        throw new Error('add failed');
    });

    await assert.rejects(root.provide('svc', {}), /add failed/);
    // 服务本身已完成登记，失败只来自联动侧。
    assert.ok(root.has('svc'));
    await root.dispose();
});
