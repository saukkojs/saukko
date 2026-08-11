import assert from 'node:assert/strict';
import test from 'node:test';
import { createScope } from '../src/scope';
import type { ConfigService } from '../src/services/config';
import type { LoggerService } from '../src/services/logger';
import { PluginContext, PluginService } from '../src/services/plugin';

function createSetup() {
    const rootScope = createScope();
    const service = new PluginService(
        { log: () => {} } as unknown as LoggerService,
        { get: () => undefined } as unknown as ConfigService,
        rootScope
    );
    return { rootScope, service };
}

function trackEvents(events: string[]) {
    return (name: string) => ({
        name,
        default: (context: PluginContext) => {
            context.lifecycle.onStart(() => {
                events.push(`start-${name}`);
            });
            context.lifecycle.onStop(() => {
                events.push(`stop-${name}`);
            });
        },
    });
}

test('disabling a service plugin auto-stops dependents and restarts them on recovery', async () => {
    const { rootScope, service } = createSetup();
    const events: string[] = [];

    await service.install({
        name: 'svc-provider',
        default: async (context) => {
            await context.share('svc', { v: 1 });
        },
    });
    await service.install({
        name: 'consumer',
        inject: ['svc'],
        default: (context) => {
            context.lifecycle.onStart(() => {
                events.push('start-consumer');
            });
            context.lifecycle.onStop(() => {
                events.push('stop-consumer');
            });
        },
    });
    await service.apply('svc-provider');
    await service.apply('consumer');
    assert.deepEqual(events, ['start-consumer']);

    // disable 服务插件：依赖方自动停止，保留期望启用（等待恢复，非用户主动禁用）。
    await service.dispose('svc-provider');
    assert.deepEqual(events, ['start-consumer', 'stop-consumer']);
    const waiting = service.map().get('consumer')!;
    assert.equal(waiting.enabled, false);
    assert.equal(waiting.desired, true);
    assert.deepEqual(waiting.missing, ['svc']);

    // 服务恢复（重新 share）：依赖方自动重新启动，dispose 返回时迁移已完成。
    await service.apply('svc-provider');
    assert.deepEqual(events, ['start-consumer', 'stop-consumer', 'start-consumer']);
    assert.equal(service.map().get('consumer')?.enabled, true);

    await rootScope.dispose();
});

test('cascades stop in reverse dependency order and restart forward', async () => {
    const { rootScope, service } = createSetup();
    const events: string[] = [];
    const track = trackEvents(events);

    await service.install({
        name: 'svc-provider',
        default: async (context) => {
            await context.share('svc', { v: 1 });
        },
    });
    // 依赖链：c -> b -> svc。
    const b = track('b');
    await service.install({ ...b, inject: ['svc'] as never });
    const c = track('c');
    await service.install({ ...c, inject: ['b'] as never });
    await service.apply('svc-provider');
    await service.apply('b');
    await service.apply('c');
    events.length = 0;

    await service.dispose('svc-provider');
    assert.deepEqual(events, ['stop-c', 'stop-b']);

    await service.apply('svc-provider');
    assert.deepEqual(events, ['stop-c', 'stop-b', 'start-b', 'start-c']);

    await rootScope.dispose();
});

test('uninstalling a depended-on plugin cascades to its dependents and reinstalling recovers them', async () => {
    const { rootScope, service } = createSetup();
    const events: string[] = [];

    await service.install({ name: 'base', default: () => {} });
    await service.install({
        name: 'dependent',
        inject: ['base'],
        default: (context) => {
            context.lifecycle.onStart(() => {
                events.push('start-dependent');
            });
            context.lifecycle.onStop(() => {
                events.push('stop-dependent');
            });
        },
    });
    await service.apply('base');
    await service.apply('dependent');
    assert.deepEqual(events, ['start-dependent']);

    // 卸载被依赖的插件：依赖方级联停止并转入等待。
    await service.remove('base');
    assert.deepEqual(events, ['start-dependent', 'stop-dependent']);
    const waiting = service.map().get('dependent')!;
    assert.equal(waiting.enabled, false);
    assert.equal(waiting.desired, true);
    assert.deepEqual(waiting.missing, ['base']);

    // 重新安装后自动恢复。
    await service.install({ name: 'base', default: () => {} });
    assert.deepEqual(events, ['start-dependent', 'stop-dependent', 'start-dependent']);
    assert.equal(service.map().get('dependent')?.enabled, true);

    await rootScope.dispose();
});

test('a user-disabled dependent does not auto-restart when the service recovers', async () => {
    const { rootScope, service } = createSetup();
    const events: string[] = [];

    await service.install({
        name: 'svc-provider',
        default: async (context) => {
            await context.share('svc', { v: 1 });
        },
    });
    await service.install({
        name: 'consumer',
        inject: ['svc'],
        default: (context) => {
            context.lifecycle.onStart(() => {
                events.push('start-consumer');
            });
        },
    });
    await service.apply('svc-provider');
    await service.apply('consumer');

    // 级联停止后用户主动 disable：取消期望启用。
    await service.dispose('svc-provider');
    await service.dispose('consumer');
    assert.equal(service.map().get('consumer')?.desired, false);

    // 服务恢复后，用户主动禁用的插件保持停止。
    await service.apply('svc-provider');
    assert.deepEqual(events, ['start-consumer']);
    assert.equal(service.map().get('consumer')?.enabled, false);

    await rootScope.dispose();
});

test('uninstalling a service provider cascades and a later provide recovers the dependents', async () => {
    const { rootScope, service } = createSetup();
    const events: string[] = [];

    await service.install({
        name: 'svc-provider',
        default: async (context) => {
            await context.share('svc', { v: 1 });
        },
    });
    await service.install({
        name: 'consumer',
        inject: ['svc'],
        default: (context) => {
            context.lifecycle.onStart(() => {
                events.push('start-consumer');
            });
            context.lifecycle.onStop(() => {
                events.push('stop-consumer');
            });
        },
    });
    await service.apply('svc-provider');
    await service.apply('consumer');

    // 卸载服务插件：share 摘除触发级联，依赖方转入等待。
    await service.remove('svc-provider');
    assert.deepEqual(events, ['start-consumer', 'stop-consumer']);
    assert.equal(rootScope.has('svc'), false);
    assert.deepEqual(service.map().get('consumer')?.missing, ['svc']);

    // 同名服务经 provide 回归：依赖方自动重启。
    await rootScope.provide('svc', { v: 2 });
    assert.deepEqual(events, ['start-consumer', 'stop-consumer', 'start-consumer']);
    assert.equal(service.map().get('consumer')?.enabled, true);

    await rootScope.dispose();
});
