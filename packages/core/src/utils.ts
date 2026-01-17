import { App } from "./app";
import { Container } from "./container";
import { ConfigService } from "./services/config";
import { LoggerService } from "./services/logger";
import { PluginService } from "./services/plugin";
import { StorageService } from "./services/storage";
import { Config } from "./types";

export function injectionProvider(container: Container, config: Config, addition: {
    headless?: boolean;
}) {
    container.register('container', () => container)
    container.register('logger', LoggerService)
    container.register('config', ConfigService)

    container.get('config').setConfig(config);

    if (addition.headless) return;

    container.register('storage', StorageService)
    container.register('plugin', PluginService)
    container.register('app', App)
}

export interface PluginDependencyIssue {
    plugin: string;
    type: 'missing-dependency' | 'circular-dependency';
    details: string[];
}

export interface PluginDiagnosisResult {
    order: string[];
    issues: PluginDependencyIssue[];
}

export function isNullish(value: any): value is null | undefined | void {
    return value === null || value === undefined;
}

export function pluginDependencyDiagnose(service: PluginService, container: Container): PluginDiagnosisResult {
    const plugins = service.map();
    const pluginNames = Array.from(plugins.keys());

    const services = container.list();
    const issues: PluginDependencyIssue[] = [];

    // 第一步：移除依赖缺失的插件（级联移除）
    let validPluginNames = new Set(pluginNames);
    let changed = true;

    while (changed) {
        changed = false;
        for (const name of validPluginNames) {
            const plugin = plugins.get(name)!;
            const deps = plugin.inject || [];

            const missingDeps: string[] = [];
            for (const dep of deps) {
                const depName = dep as string;
                // 依赖是有效服务，跳过
                if (services.includes(depName)) continue;

                // 依赖是有效插件，跳过
                if (validPluginNames.has(depName)) continue;

                // 依赖无效，记录
                missingDeps.push(depName);
            }

            if (missingDeps.length > 0) {
                // 依赖无效，移除该插件
                validPluginNames.delete(name);
                issues.push({
                    plugin: name,
                    type: 'missing-dependency',
                    details: missingDeps
                });
                changed = true;
            }
        }
    }

    // 第二步：在有效插件中检测循环依赖
    const circularPlugins = detectCircularDependencies(validPluginNames, plugins, services);
    for (const [plugin, cycle] of circularPlugins) {
        validPluginNames.delete(plugin);
        issues.push({
            plugin,
            type: 'circular-dependency',
            details: cycle
        });
    }

    // 第三步：对最终有效的插件进行拓扑排序
    const adj = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const name of validPluginNames) {
        adj.set(name, []);
        inDegree.set(name, 0);
    }

    for (const name of validPluginNames) {
        const plugin = plugins.get(name)!;
        const deps = plugin.inject || [];

        for (const dep of deps) {
            const depName = dep as string;
            if (validPluginNames.has(depName)) {
                // dep -> name (dep must be loaded before name)
                adj.get(depName)!.push(name);
                inDegree.set(name, (inDegree.get(name) || 0) + 1);
            }
        }
    }

    // 拓扑排序
    const queue: string[] = [];
    for (const [name, deg] of inDegree) {
        if (deg === 0) {
            queue.push(name);
        }
    }

    const result: string[] = [];

    while (queue.length > 0) {
        const u = queue.shift()!;
        result.push(u);

        const neighbors = adj.get(u) || [];
        for (const v of neighbors) {
            inDegree.set(v, inDegree.get(v)! - 1);
            if (inDegree.get(v) === 0) {
                queue.push(v);
            }
        }
    }

    return {
        order: result,
        issues
    };
}

// 辅助函数：检测循环依赖
function detectCircularDependencies(
    validPlugins: Set<string>,
    plugins: Map<string, any>,
    services: string[]
): Map<string, string[]> {
    const circularPlugins = new Map<string, string[]>();
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const path: string[] = [];

    function dfs(node: string): boolean {
        if (recStack.has(node)) {
            // 找到循环，提取循环路径
            const cycleStart = path.indexOf(node);
            const cycle = path.slice(cycleStart);
            cycle.push(node); // 添加循环的起点作为终点
            
            // 标记循环中的所有插件
            for (const p of cycle) {
                if (!circularPlugins.has(p)) {
                    circularPlugins.set(p, cycle);
                }
            }
            return true;
        }

        if (visited.has(node)) {
            return false;
        }

        visited.add(node);
        recStack.add(node);
        path.push(node);

        const plugin = plugins.get(node);
        const deps = plugin?.inject || [];

        for (const dep of deps) {
            const depName = dep as string;
            // 只检查插件依赖，不检查服务依赖
            if (services.includes(depName)) continue;
            if (!validPlugins.has(depName)) continue;

            if (dfs(depName)) {
                // 继续传播循环检测
                return true;
            }
        }

        recStack.delete(node);
        path.pop();
        return false;
    }

    // 对每个插件进行DFS检测
    for (const plugin of validPlugins) {
        if (!visited.has(plugin)) {
            dfs(plugin);
        }
    }

    return circularPlugins;
}