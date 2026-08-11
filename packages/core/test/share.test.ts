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

test('a shared service is visible from the root scope and readable by other plugins', async () => {
    const { rootScope, service } = createSetup();
    const echo = { echo: (s: string) => s };
    let seen: unknown;

    await service.install({
        name: 'echo-provider',
        default: async (context) => {
            await context.share('echo', echo);
        },
    });
    // install 时即提升到根作用域（未 enable 也可读）。
    assert.equal(rootScope.get('echo'), echo);

    await service.install({
        name: 'consumer',
        inject: ['echo'],
        default: (context) => {
            seen = context.get('echo');
        },
    });
    assert.equal(seen, echo);

    await rootScope.dispose();
});

test('share defaults the service name to the plugin name', async () => {
    const { rootScope, service } = createSetup();
    const instance = { kind: 'self-named' };

    await service.install({
        name: 'self-service',
        default: async (context) => {
            await context.share(instance);
        },
    });

    assert.equal(rootScope.get('self-service'), instance);
    await rootScope.dispose();
});

test('a shared service starts/stops with the plugin lifecycle and is removed on disable', async () => {
    const { rootScope, service } = createSetup();
    const calls: string[] = [];
    const svc = {
        start: () => { calls.push('start'); },
        stop: () => { calls.push('stop'); },
    };

    await service.install({
        name: 'lifecycle-svc',
        default: async (context) => {
            await context.share('lifecycle-svc', svc);
        },
    });
    // install 时登记但不启动。
    assert.ok(rootScope.has('lifecycle-svc'));
    assert.deepEqual(calls, []);

    await service.apply('lifecycle-svc');
    assert.deepEqual(calls, ['start']);

    // disable：停止并从根作用域摘除。
    await service.dispose('lifecycle-svc');
    assert.deepEqual(calls, ['start', 'stop']);
    assert.equal(rootScope.has('lifecycle-svc'), false);

    // 重新 enable：重新登记并启动。
    await service.apply('lifecycle-svc');
    assert.deepEqual(calls, ['start', 'stop', 'start']);
    assert.ok(rootScope.has('lifecycle-svc'));

    await rootScope.dispose();
});

test('disable and re-enable of a shared service trigger onRemove/onAdd respectively', async () => {
    const { rootScope, service } = createSetup();
    const calls: string[] = [];
    rootScope.onRemove('watched', (name) => { calls.push(`remove-${name}`); });
    rootScope.onAdd('watched', (name) => { calls.push(`add-${name}`); });

    await service.install({
        name: 'watched-provider',
        default: async (context) => {
            await context.share('watched', { kind: 'watched' });
        },
    });
    assert.deepEqual(calls, ['add-watched']);

    await service.apply('watched-provider');
    await service.dispose('watched-provider');
    assert.deepEqual(calls, ['add-watched', 'remove-watched']);

    await service.apply('watched-provider');
    assert.deepEqual(calls, ['add-watched', 'remove-watched', 'add-watched']);

    await rootScope.dispose();
});

test('uninstall removes the shared service without residue', async () => {
    const { rootScope, service } = createSetup();

    await service.install({
        name: 'doomed-provider',
        default: async (context) => {
            await context.share('doomed-svc', { kind: 'doomed' });
        },
    });
    assert.ok(rootScope.has('doomed-svc'));

    await service.remove('doomed-provider');
    assert.equal(rootScope.has('doomed-svc'), false);

    // 同名服务可被后续登记者复用。
    await rootScope.provide('doomed-svc', { kind: 'reused' });
    assert.equal(rootScope.get<{ kind: string }>('doomed-svc')?.kind, 'reused');

    await rootScope.dispose();
});

test('sharing a name already registered in the root scope fails the install', async () => {
    const { rootScope, service } = createSetup();
    rootScope.set('taken', 1);

    await assert.rejects(
        service.install({
            name: 'conflicting',
            default: async (context) => {
                await context.share('taken', {});
            },
        }),
        /already registered in the root scope/
    );
    // 主体失败不留记录，根作用域登记未被遮蔽。
    assert.equal(service.map().has('conflicting'), false);
    assert.equal(rootScope.get('taken'), 1);

    // 两个插件提升同名服务同样冲突。
    await service.install({
        name: 'first',
        default: async (context) => {
            await context.share('dup', {});
        },
    });
    await assert.rejects(
        service.install({
            name: 'second',
            default: async (context) => {
                await context.share('dup', {});
            },
        }),
        /already registered in the root scope/
    );

    await rootScope.dispose();
});

test('a suspended dependent resumes when a service plugin shares its dependency', async () => {
    const { rootScope, service } = createSetup();
    const events: string[] = [];

    // 消费方先安装：依赖的服务尚不存在，主体挂起。
    await service.install({
        name: 'waiting-consumer',
        inject: ['shared-svc'],
        default: (context) => {
            events.push('consumer-mounted');
            context.lifecycle.onStart(() => {
                events.push(`consumer-started:${context.get<{ v: number }>('shared-svc')?.v}`);
            });
        },
    });
    await service.apply('waiting-consumer');
    assert.deepEqual(events, []);

    // 服务插件 install：主体执行时 share 提升服务，等待中的消费方随即解除挂起并自动启动；
    // 全链路可等待——install 返回时迁移已完成。
    await service.install({
        name: 'shared-svc-provider',
        default: async (context) => {
            await context.share('shared-svc', { v: 42 });
        },
    });
    assert.deepEqual(events, ['consumer-mounted', 'consumer-started:42']);
    assert.equal(service.map().get('waiting-consumer')?.enabled, true);

    await rootScope.dispose();
});

test('sharing while the plugin is active starts the service immediately', async () => {
    const { rootScope, service } = createSetup();
    const calls: string[] = [];
    let shareNow!: () => Promise<void>;

    await service.install({
        name: 'late-sharer',
        default: (context) => {
            context.lifecycle.onStart(() => {
                shareNow = async () => {
                    await context.share('late-svc', {
                        start: () => { calls.push('start'); },
                        stop: () => { calls.push('stop'); },
                    });
                };
            });
        },
    });
    await service.apply('late-sharer');

    // ACTIVE 期间 share：立即登记并启动。
    await shareNow();
    assert.deepEqual(calls, ['start']);
    assert.ok(rootScope.has('late-svc'));

    // 后续 stop/start 周期由钩子驱动，行为与 install 期 share 一致。
    await service.dispose('late-sharer');
    assert.deepEqual(calls, ['start', 'stop']);
    assert.equal(rootScope.has('late-svc'), false);

    await service.apply('late-sharer');
    assert.deepEqual(calls, ['start', 'stop', 'start']);
    assert.ok(rootScope.has('late-svc'));

    await rootScope.dispose();
});
