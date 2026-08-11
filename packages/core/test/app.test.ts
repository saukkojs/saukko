import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from '../src/app';
import { LifecycleState } from '../src/lifecycle';
import { createScope, type Scope } from '../src/scope';
import type { ConfigService } from '../src/services/config';
import type { LoggerService } from '../src/services/logger';
import { PluginContext, PluginService } from '../src/services/plugin';

test('App stops every enabled plugin when one plugin cleanup fails', async () => {
    const stopped: string[] = [];
    const logs: unknown[][] = [];
    const plugin = {
        map: () => new Map([
            ['broken', { enabled: true }],
            ['healthy', { enabled: true }],
        ]),
        dispose: async (name: string) => {
            stopped.push(name);
            if (name === 'broken') throw new Error('broken cleanup');
        },
    } as unknown as PluginService;
    const logger = {
        log: (...args: unknown[]) => logs.push(args),
    } as unknown as LoggerService;
    const app = new App(logger, plugin, { list: () => [] } as unknown as Scope);

    await assert.rejects(app.stop(), /broken cleanup/);

    // 停止顺序为启动序列的逆序（LIFO），失败的插件不阻断其余插件。
    assert.deepEqual(stopped, ['healthy', 'broken']);
    assert.equal(logs.at(-1)?.[2], 'App stopped.');
});

test('App stops plugins in reverse dependency order and disposes their scopes', async () => {
    const stopped: string[] = [];
    const contexts = new Map<string, PluginContext>();
    const rootScope = createScope();
    const plugin = new PluginService(
        { log: () => {} } as unknown as LoggerService,
        { get: () => undefined } as unknown as ConfigService,
        rootScope
    );
    // 故意打乱安装顺序，依赖链为 top -> mid -> base。
    for (const [name, inject] of [['top', ['mid']], ['base', []], ['mid', ['base']]] as const) {
        plugin.install({
            name,
            inject: inject as never,
            default: (context) => {
                contexts.set(name, context);
                context.lifecycle.onStop(() => {
                    stopped.push(name);
                });
            },
        });
    }
    const app = new App({ log: () => {} } as unknown as LoggerService, plugin, rootScope);

    await app.start();
    await app.stop();

    assert.deepEqual(stopped, ['top', 'mid', 'base']);
    for (const context of contexts.values()) {
        assert.equal(context.scope.lifecycle.state, LifecycleState.STOPPED);
    }
});
