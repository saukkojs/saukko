import assert from 'node:assert/strict';
import test from 'node:test';
import { LifecycleState } from '../src/lifecycle';
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

test('re-providing a service restarts dependent plugins with the new instance', async () => {
    const { rootScope, service } = createSetup();
    const seen: unknown[] = [];
    const stopped: string[] = [];
    const contexts: PluginContext[] = [];

    await rootScope.provide('svc', { version: 1 });
    service.install({
        name: 'consumer',
        inject: ['svc'],
        default: (context) => {
            contexts.push(context);
            seen.push(context.get('svc'));
            context.lifecycle.onStop(() => {
                stopped.push('consumer');
            });
        },
    });
    await service.apply('consumer');
    assert.deepEqual(seen, [{ version: 1 }]);

    await rootScope.provide('svc', { version: 2 });

    // 旧 Context 已随子作用域销毁，插件以新服务实例重新启用。
    assert.deepEqual(stopped, ['consumer']);
    assert.deepEqual(seen, [{ version: 1 }, { version: 2 }]);
    assert.equal(contexts[0].scope.lifecycle.state, LifecycleState.STOPPED);
    assert.equal(contexts[1].scope.lifecycle.state, LifecycleState.ACTIVE);
    assert.equal(service.map().get('consumer')?.enabled, true);

    await rootScope.dispose();
});

test('linked restarts stop in reverse dependency order and restart forward', async () => {
    const { rootScope, service } = createSetup();
    const events: string[] = [];
    const track = (name: string, inject?: readonly string[]) => {
        service.install({
            name,
            inject: inject as never,
            default: (context) => {
                events.push(`start-${name}`);
                context.lifecycle.onStop(() => {
                    events.push(`stop-${name}`);
                });
            },
        });
    };

    await rootScope.provide('svc', { version: 1 });
    // p2 传递依赖 svc：p2 -> p1 -> svc。
    track('p1', ['svc']);
    track('p2', ['p1']);
    track('unrelated');
    await service.apply('p1');
    await service.apply('p2');
    await service.apply('unrelated');
    events.length = 0;

    await rootScope.provide('svc', { version: 2 });

    assert.deepEqual(events, ['stop-p2', 'stop-p1', 'start-p1', 'start-p2']);
    assert.equal(service.map().get('unrelated')?.enabled, true);

    await rootScope.dispose();
});

test('a disabled dependent is not restarted by a service replacement', async () => {
    const { rootScope, service } = createSetup();
    let applies = 0;

    await rootScope.provide('svc', { version: 1 });
    service.install({
        name: 'dormant',
        inject: ['svc'],
        default: () => {
            applies += 1;
        },
    });
    await service.apply('dormant');
    await service.dispose('dormant');
    assert.equal(applies, 1);

    await rootScope.provide('svc', { version: 2 });
    assert.equal(applies, 1);
    assert.equal(service.map().get('dormant')?.enabled, false);

    await rootScope.dispose();
});

test('a plugin failing to restart ends disabled and the failure reaches the provide caller', async () => {
    const { rootScope, service } = createSetup();
    let attempts = 0;

    await rootScope.provide('svc', { version: 1 });
    service.install({
        name: 'fragile',
        inject: ['svc'],
        default: () => {
            attempts += 1;
            if (attempts === 2) throw new Error('restart failed');
        },
    });
    await service.apply('fragile');

    await assert.rejects(rootScope.provide('svc', { version: 2 }), /restart failed/);
    // apply 失败路径已清理 Context 并复位状态，插件保持可重试。
    assert.equal(service.map().get('fragile')?.enabled, false);
    await service.apply('fragile');
    assert.equal(service.map().get('fragile')?.enabled, true);

    await rootScope.dispose();
});
