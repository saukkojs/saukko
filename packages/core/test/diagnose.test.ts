import assert from 'node:assert/strict';
import test from 'node:test';
import { createScope, type Scope } from '../src/scope';
import type { ConfigService } from '../src/services/config';
import type { LoggerService } from '../src/services/logger';
import { PluginContext, PluginService } from '../src/services/plugin';
import { pluginDependencyDiagnose } from '../src/utils';

function createPluginService(rootScope: Scope) {
    return new PluginService(
        { log: () => {} } as unknown as LoggerService,
        { get: () => undefined } as unknown as ConfigService,
        rootScope
    );
}

test('diagnosis resolves service dependencies against the scope registry', async () => {
    const scope = createScope();
    scope.register('svc', () => ({ kind: 'svc' }));
    const plugin = createPluginService(scope);
    await plugin.install({ name: 'uses-svc', inject: ['svc'], default: () => {} });
    await plugin.install({ name: 'uses-ghost', inject: ['ghost'], default: () => {} });

    const diagnosis = pluginDependencyDiagnose(plugin, scope);

    assert.deepEqual(diagnosis.order, ['uses-svc']);
    assert.deepEqual(diagnosis.issues, [{
        plugin: 'uses-ghost',
        type: 'missing-dependency',
        details: ['ghost'],
    }]);
});

test('re-diagnosing after a dynamic service registration clears the missing dependency', async () => {
    const scope = createScope();
    const plugin = createPluginService(scope);
    let context!: PluginContext;
    await plugin.install({
        name: 'late-bound',
        inject: ['late-svc'],
        default: (ctx) => {
            context = ctx;
        },
    });

    // 初始诊断：依赖缺失，插件被排除出启动序列。
    const before = pluginDependencyDiagnose(plugin, scope);
    assert.deepEqual(before.order, []);
    assert.deepEqual(before.issues, [{
        plugin: 'late-bound',
        type: 'missing-dependency',
        details: ['late-svc'],
    }]);

    // 服务动态登记进作用域后重新诊断，插件恢复有效并可启用。
    const service = { kind: 'late-svc' };
    scope.register('late-svc', () => service);
    const after = pluginDependencyDiagnose(plugin, scope);
    assert.deepEqual(after.order, ['late-bound']);
    assert.deepEqual(after.issues, []);

    await plugin.apply('late-bound');
    // 主体在 install 时已执行（当时依赖缺失）；读取沿父链动态解析，
    // 依赖补齐后随时可读到新服务。
    assert.equal(context.get('late-svc'), service);
});

test('circular plugin dependencies are reported and excluded from the start order', async () => {
    const scope = createScope();
    const plugin = createPluginService(scope);
    await plugin.install({ name: 'a', inject: ['b'], default: () => {} });
    await plugin.install({ name: 'b', inject: ['a'], default: () => {} });
    await plugin.install({ name: 'independent', default: () => {} });

    const diagnosis = pluginDependencyDiagnose(plugin, scope);

    assert.deepEqual(diagnosis.order, ['independent']);
    const circular = diagnosis.issues.filter((issue) => issue.type === 'circular-dependency');
    assert.deepEqual(circular.map((issue) => issue.plugin).sort(), ['a', 'b']);
});

test('disabling a depended-on plugin makes re-diagnosis flag its dependents as missing', async () => {
    const scope = createScope();
    const plugin = createPluginService(scope);
    await plugin.install({ name: 'base', default: () => {} });
    await plugin.install({ name: 'top', inject: ['base'], default: () => {} });

    await plugin.apply('base');
    await plugin.apply('top');
    assert.deepEqual(pluginDependencyDiagnose(plugin, scope).issues, []);

    // base 卸载后重新诊断：top 的插件依赖不再有效，被级联标记缺失。
    await plugin.remove('base');
    const diagnosis = pluginDependencyDiagnose(plugin, scope);
    assert.deepEqual(diagnosis.order, []);
    assert.deepEqual(diagnosis.issues, [{
        plugin: 'top',
        type: 'missing-dependency',
        details: ['base'],
    }]);
});
