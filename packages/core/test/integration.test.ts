import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/app';
import { LifecycleState } from '../src/lifecycle';
import { createScope } from '../src/scope';
import { PluginContext, PluginService } from '../src/services/plugin';
import type { Config } from '../src/types';
import { injectionProvider } from '../src/utils';

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'saukko-core-test-'));
}

function createConfig(storagePath: string): Config {
    return {
        project: { name: 'integration-test' },
        plugin: { config: {} },
        service: { config: { storage: { path: storagePath } } },
    };
}

/** 与 daemon 相同的装配路径：根作用域 + injectionProvider。 */
function assemble(config: Config) {
    const rootScope = createScope();
    injectionProvider(rootScope, config, { headless: false });
    return {
        rootScope,
        app: rootScope.get<App>('app')!,
        plugin: rootScope.get<PluginService>('plugin')!,
    };
}

test('full assembly starts and stops plugins through the real scope tree', async () => {
    const storageDir = createTempDir();
    const { rootScope, app, plugin } = assemble(createConfig(storageDir));
    const events: string[] = [];
    const contexts = new Map<string, PluginContext>();
    const track = (name: string, inject?: readonly string[]) => {
        plugin.install({
            name,
            inject: inject as never,
            default: (context) => {
                events.push(`start-${name}`);
                contexts.set(name, context);
                context.lifecycle.onStop(() => {
                    events.push(`stop-${name}`);
                });
            },
        });
    };

    // 外部服务走 daemon 的 register 路径；插件混合依赖外部服务、核心服务与插件。
    rootScope.register('ext-svc', () => ({ kind: 'ext-svc' }));
    track('base-ext', ['ext-svc']);
    track('uses-storage', ['storage']);
    track('top', ['base-ext']);
    // 缺失依赖的插件应被诊断跳过，不影响其余插件。
    track('broken', ['ghost-svc']);

    let storageValue: string | null = null;
    plugin.install({
        name: 'storage-writer',
        inject: ['storage'],
        default: (context) => {
            const storage = context.get<{ init: (n: string) => { setItem: (k: string, v: unknown) => void } }>('storage')!;
            storage.init('integration').setItem('written', 'yes');
            storageValue = 'yes';
        },
    });

    await app.start();

    assert.equal(storageValue, 'yes');
    assert.equal(plugin.map().get('broken')?.enabled, false);
    // 拓扑序：base-ext 先于 top；其余相对顺序不限。
    // （storage-writer 未挂事件追踪，只验证存储副作用。）
    const started = events.filter((event) => event.startsWith('start-'));
    assert.equal(started.length, 3);
    assert.ok(started.indexOf('start-base-ext') < started.indexOf('start-top'));
    for (const [name, context] of contexts) {
        assert.equal(context.scope.lifecycle.state, LifecycleState.ACTIVE, name);
    }

    await app.stop();

    const stopped = events.filter((event) => event.startsWith('stop-'));
    assert.equal(stopped.length, 3);
    // 停止为启动拓扑的逆序：top 先于 base-ext。
    assert.ok(stopped.indexOf('stop-top') < stopped.indexOf('stop-base-ext'));
    for (const [name, context] of contexts) {
        assert.equal(context.scope.lifecycle.state, LifecycleState.DISPOSED, name);
    }

    await rootScope.dispose();
});

test('real async resources are released exactly once when the app stops', async () => {
    const { rootScope, app, plugin } = assemble(createConfig(createTempDir()));
    const cleanups: string[] = [];
    let ticks = 0;
    let port = 0;

    plugin.install({
        name: 'resource-owner',
        default: async (context) => {
            // 真实定时器：停止后不得再有回调触发。
            const interval = setInterval(() => {
                ticks += 1;
            }, 10);
            // 真实 TCP 服务：停止后端口必须关闭。
            const server = net.createServer();
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            port = (server.address() as net.AddressInfo).port;
            context.lifecycle.onStop(async () => {
                clearInterval(interval);
                cleanups.push('interval');
                await new Promise<void>((resolve) => server.close(() => resolve()));
                cleanups.push('server');
            });
        },
    });

    await app.start();
    assert.ok(port > 0, 'server should be listening');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.ok(ticks > 0, 'interval should be ticking');

    await app.stop();
    assert.deepEqual(cleanups.sort(), ['interval', 'server']);

    // 无悬挂任务：定时器不再触发。
    const ticksAtStop = ticks;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(ticks, ticksAtStop);

    // 端口已释放：连接应立即被拒绝。
    await assert.rejects(
        new Promise<void>((resolve, reject) => {
            const client = net.createConnection(port, '127.0.0.1', () => {
                client.end();
                resolve();
            });
            client.on('error', reject);
        }),
        /ECONNREFUSED/
    );

    // 无重复清理：对同一插件再次 dispose 不会重跑清理。
    await plugin.dispose('resource-owner');
    assert.deepEqual(cleanups.sort(), ['interval', 'server']);

    await rootScope.dispose();
});
