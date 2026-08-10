import assert from 'node:assert/strict';
import test from 'node:test';
import { LifecycleState } from '../src/lifecycle';
import { createScope } from '../src/scope';

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
