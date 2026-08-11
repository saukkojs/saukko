import assert from 'node:assert/strict';
import test from 'node:test';
import { createScope } from '../src/scope';
import type { ConfigService } from '../src/services/config';
import type { LoggerService } from '../src/services/logger';
import { PluginService } from '../src/services/plugin';

function createSetup() {
    const rootScope = createScope();
    const service = new PluginService(
        { log: () => {} } as unknown as LoggerService,
        { get: () => undefined } as unknown as ConfigService,
        rootScope
    );
    return { rootScope, service };
}

test('install with a missing service dependency suspends the body until provided', async () => {
    const { rootScope, service } = createSetup();
    let mounted = false;

    await service.install({
        name: 'late',
        inject: ['svc'],
        default: () => {
            mounted = true;
        },
    });

    // 依赖缺失：主体挂起，记录等待清单。
    assert.equal(mounted, false);
    assert.deepEqual(service.map().get('late')?.missing, ['svc']);

    // provide 新增服务触发等待迁移，且迁移完成才返回（无 fire-and-forget）。
    await rootScope.provide('svc', { kind: 'svc' });
    assert.equal(mounted, true);
    assert.deepEqual(service.map().get('late')?.missing, []);

    await rootScope.dispose();
});

test('enabling a waiting plugin marks it desired and it auto-starts when dependencies arrive', async () => {
    const { rootScope, service } = createSetup();
    const events: string[] = [];

    await service.install({
        name: 'waiter',
        inject: ['svc'],
        default: (context) => {
            events.push('mounted');
            context.lifecycle.onStart(() => {
                events.push('started');
            });
        },
    });

    // 依赖缺失时不拒绝启用：标记期望启用并等待。
    await service.apply('waiter');
    assert.equal(service.map().get('waiter')?.enabled, false);
    assert.equal(service.map().get('waiter')?.desired, true);
    assert.deepEqual(events, []);

    // 依赖补齐：自动执行主体并按期望状态启动，provide 返回时迁移已完成。
    await rootScope.provide('svc', { kind: 'svc' });
    assert.deepEqual(events, ['mounted', 'started']);
    assert.equal(service.map().get('waiter')?.enabled, true);

    await rootScope.dispose();
});

test('installing a depended-on plugin resumes suspended dependents', async () => {
    const { rootScope, service } = createSetup();
    const mounted: string[] = [];

    // 先安装依赖方：被依赖的插件尚未安装，主体挂起。
    await service.install({
        name: 'dependent',
        inject: ['base'],
        default: () => {
            mounted.push('dependent');
        },
    });
    assert.deepEqual(mounted, []);
    assert.deepEqual(service.map().get('dependent')?.missing, ['base']);

    // 被依赖插件 install 即解除等待（插件依赖以"已安装"为就绪判据）。
    await service.install({
        name: 'base',
        default: () => {
            mounted.push('base');
        },
    });
    assert.deepEqual(mounted, ['base', 'dependent']);
    assert.deepEqual(service.map().get('dependent')?.missing, []);

    await rootScope.dispose();
});

test('a suspended plugin failing to mount on readiness is dropped and the failure reaches the provide caller', async () => {
    const { rootScope, service } = createSetup();

    await service.install({
        name: 'fragile',
        inject: ['svc'],
        default: () => {
            throw new Error('mount failed');
        },
    });
    assert.deepEqual(service.map().get('fragile')?.missing, ['svc']);

    // 自动迁移可等待且失败可诊断：provide 聚合上抛，插件记录被摘除（可重新 install 重试）。
    await assert.rejects(rootScope.provide('svc', { kind: 'svc' }), /mount failed/);
    assert.equal(service.map().has('fragile'), false);

    await rootScope.dispose();
});

test('a disabled desired flag is cancelled: dependencies arriving later do not start the plugin', async () => {
    const { rootScope, service } = createSetup();
    let started = false;

    await service.install({
        name: 'cancelled',
        inject: ['svc'],
        default: (context) => {
            context.lifecycle.onStart(() => {
                started = true;
            });
        },
    });

    await service.apply('cancelled');
    assert.equal(service.map().get('cancelled')?.desired, true);
    // 等待期间 disable：取消期望启用。
    await service.dispose('cancelled');
    assert.equal(service.map().get('cancelled')?.desired, false);

    // 依赖补齐后主体仍会执行（install 语义），但不会自动启动。
    await rootScope.provide('svc', { kind: 'svc' });
    assert.equal(started, false);
    assert.equal(service.map().get('cancelled')?.enabled, false);

    await rootScope.dispose();
});

test('uninstalling a waiting plugin leaves no watchers or records behind', async () => {
    const { rootScope, service } = createSetup();
    let mounted = false;

    await service.install({
        name: 'doomed',
        inject: ['svc'],
        default: () => {
            mounted = true;
        },
    });
    assert.deepEqual(service.map().get('doomed')?.missing, ['svc']);

    await service.remove('doomed');
    assert.equal(service.map().has('doomed'), false);

    // 依赖补齐后已卸载的插件不会被挂载。
    await rootScope.provide('svc', { kind: 'svc' });
    assert.equal(mounted, false);

    await rootScope.dispose();
});
