import assert from 'node:assert/strict';
import test from 'node:test';
import { LifecycleState } from '../src/lifecycle';
import { createScope } from '../src/scope';
import type { ConfigService } from '../src/services/config';
import type { LoggerService } from '../src/services/logger';
import { PluginContext, PluginService } from '../src/services/plugin';

function createPluginService() {
    return new PluginService(
        // 缺省根作用域：辅助函数安装的插件均不声明 inject，无需外部服务。
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

    await service.install({
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

test('a failed plugin install cleans up its scope and can be retried', async () => {
    const service = createPluginService();
    const cleanups: string[] = [];
    let attempts = 0;

    const plugin = {
        name: 'retryable',
        default: (context: PluginContext) => {
            attempts += 1;
            context.lifecycle.onStop(() => {
                cleanups.push(`cleanup-${attempts}`);
            });
            if (attempts === 1) throw new Error('install failed');
        },
    };

    // install 即执行主体：失败时销毁子作用域（已注册的清理照常执行），不留记录。
    await assert.rejects(service.install(plugin), /install failed/);
    assert.deepEqual(cleanups, ['cleanup-1']);
    assert.equal(service.map().has('retryable'), false);

    // 重试即重新 install，主体再次执行。
    await service.install(plugin);
    await service.apply('retryable');
    assert.equal(service.map().get('retryable')?.enabled, true);

    await service.dispose('retryable');
    assert.deepEqual(cleanups, ['cleanup-1', 'cleanup-2']);
});

test('a failed uninstall keeps a disabled plugin available for a retry', async () => {
    const service = createPluginService();
    let cleanupAttempts = 0;

    await service.install({
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

test('an installed plugin reads injected services through its child scope; undeclared services stay readable via the parent chain', async () => {
    const services: Record<string, unknown> = { storage: { kind: 'storage' } };
    const rootScope = createScope();
    rootScope.set('storage', services.storage);
    const service = new PluginService(
        { log: () => {} } as unknown as LoggerService,
        { get: () => undefined } as unknown as ConfigService,
        rootScope
    );
    let consumer!: PluginContext;
    let bystander!: PluginContext;
    // install 即执行主体：Context 在 install 完成后即可用。
    await service.install({
        name: 'consumer',
        inject: ['storage'],
        default: (context) => {
            consumer = context;
        },
    });
    await service.install({
        name: 'bystander',
        default: (context) => {
            bystander = context;
        },
    });

    assert.equal(consumer.get('storage'), services.storage);
    assert.equal(consumer.has('storage'), true);
    // 未声明 inject 的插件也可沿父链读取根作用域服务（全量可读语义）；
    // 归属隔离由“插件自有登记”用例覆盖。
    assert.equal(bystander.get('storage'), services.storage);
    // 兼容的 dependencies 记录为 install 时的注入快照。
    assert.equal((consumer.dependencies as Record<string, unknown>).storage, services.storage);
});

test('plugin scope registrations belong to the plugin scope and are released on uninstall', async () => {
    const service = createPluginService();
    let owner!: PluginContext;
    let bystander!: PluginContext;
    await service.install({
        name: 'owner',
        default: (context) => {
            owner = context;
            context.set('custom', 42);
        },
    });
    await service.install({
        name: 'bystander',
        default: (context) => {
            bystander = context;
        },
    });
    await service.apply('owner');
    await service.apply('bystander');

    assert.equal(owner.get('custom'), 42);
    assert.equal(bystander.has('custom'), false);

    // disable 仅停止生命周期，作用域不销毁：登记保留，可再次 enable。
    await service.dispose('owner');
    assert.equal(owner.scope.lifecycle.state, LifecycleState.STOPPED);
    assert.equal(owner.get('custom'), 42);
    await service.apply('owner');
    assert.equal(owner.scope.lifecycle.state, LifecycleState.ACTIVE);
    // 兄弟插件的作用域不受波及。
    assert.equal(bystander.scope.lifecycle.state, LifecycleState.ACTIVE);

    // uninstall 才终态销毁作用域。
    await service.remove('owner');
    assert.equal(owner.scope.lifecycle.state, LifecycleState.DISPOSED);
    assert.throws(() => owner.set('late', 1), /disposed/);
});

test('disabled plugins do not receive business events; listeners survive re-enable', async () => {
    const service = createPluginService();
    const calls: string[] = [];
    let emitter!: PluginContext;
    await service.install({
        name: 'listener',
        default: (context) => {
            context.on('test.event' as never, () => {
                calls.push('received');
            });
        },
    });
    await service.install({
        name: 'emitter',
        default: (context) => {
            emitter = context;
        },
    });
    await service.apply('listener');
    await service.apply('emitter');
    const event = { name: 'test.event', data: { value: 'x' } };

    emitter.emit('test.event' as never, event as never);
    assert.deepEqual(calls, ['received']);

    // 禁用后监听仍登记但受门控，不再接收事件。
    await service.dispose('listener');
    emitter.emit('test.event' as never, event as never);
    assert.deepEqual(calls, ['received']);

    // 重新启用后同一监听自动恢复接收。
    await service.apply('listener');
    emitter.emit('test.event' as never, event as never);
    assert.deepEqual(calls, ['received', 'received']);
});

test('plugins can be installed as functions, classes or apply-objects', async () => {
    const rootScope = createScope();
    rootScope.set('token', 'T');
    const service = new PluginService(
        { log: () => {} } as unknown as LoggerService,
        { get: () => undefined } as unknown as ConfigService,
        rootScope
    );
    const mounted: string[] = [];

    // 函数形态：函数名即插件名，inject 作为函数属性声明。
    function functionPlugin(context: PluginContext) {
        mounted.push(`function:${context.get('token')}`);
    }
    Object.assign(functionPlugin, { inject: ['token'] });

    // 类形态：实例化即完成挂载。
    class ClassPlugin {
        constructor(context: PluginContext) {
            mounted.push(`class:${context.get('token')}`);
        }
    }

    // 对象形态：name 属性 + apply 方法。
    const objectPlugin = {
        name: 'object-plugin',
        apply(context: PluginContext) {
            mounted.push(`object:${context.get('token')}`);
        },
    };

    // install 即执行主体：多形态归一化后的挂载副作用此时已发生。
    await service.install(functionPlugin);
    await service.install(ClassPlugin);
    await service.install(objectPlugin);
    assert.deepEqual(mounted, ['function:T', 'class:T', 'object:T']);

    await service.apply('functionPlugin');
    await service.apply('ClassPlugin');
    await service.apply('object-plugin');

    assert.equal(service.map().get('functionPlugin')?.enabled, true);
    assert.equal(service.map().get('ClassPlugin')?.enabled, true);
    assert.equal(service.map().get('object-plugin')?.enabled, true);

    await rootScope.dispose();
});

test('plugins without a resolvable name or in an invalid shape are rejected', async () => {
    const service = createPluginService();

    await assert.rejects(service.install((() => {}) as never), /匿名函数/);
    await assert.rejects(service.install({ default: () => {} } as never), /模块形态需提供 name/);
    await assert.rejects(service.install({ apply: () => {} } as never), /对象形态需提供 name/);
    await assert.rejects(service.install(42 as never), /插件格式不正确/);
});
