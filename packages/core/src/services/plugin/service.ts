import { Container, ServiceRegistry } from "../../container";
import { createContainerScope, Scope } from "../../scope";
// 与 utils 存在模块级循环引用（utils 的 injectionProvider 构造 PluginService）；
// pluginDependencyDiagnose 是函数声明，模块实例化阶段即完成提升，运行时调用安全。
import { pluginDependencyDiagnose } from "../../utils";
import { ConfigService } from "../config";
import { LoggerService } from "../logger";
import { Bot } from "./bot";
import { PluginContext } from "./context";
import { EventListener, Events } from "./types";

type AsyncAble<T> = T | Promise<T>;

export interface PluginType {
    inject?: readonly (keyof ServiceRegistry)[];
    name: string;
    default: (context: PluginContext) => AsyncAble<void>;
}

export interface PluginMapItem {
    name: string;
    module: PluginType;
    context: PluginContext | undefined;
    config: Record<string, any> | undefined;
    enabled: boolean;
}

export class PluginService {
    static inject = ['container', 'logger', 'config'] as const;
    private plugins = new Map<string, PluginMapItem>();
    private bots: Array<Bot> = [];
    private sharedEventListeners = new Map<string, EventListener<keyof Events>[]>();
    private readonly rootScope: Scope;
    private readonly replaceWatchers = new Map<string, { count: number; off: () => void }>();

    constructor(
        private container: Container,
        private logger: LoggerService,
        private config: ConfigService,
        rootScope?: Scope
    ) {
        // 未显式传入时退化为仅衔接容器的空根（兼容旧用法）；
        // 正常路径由 injectionProvider 传入应用根作用域。
        this.rootScope = rootScope ?? createContainerScope(container);
    }

    install(pluginModule: PluginType) {
        if (this.plugins.has(pluginModule.name)) {
            this.logger.log('plugin', 'error', `Plugin ${pluginModule.name} is already installed`);
            this.logger.log('plugin', 'notice', 'In current version, creating multiple instances for a plugin is not supported.');
            return;
        }
        const dependencies = pluginModule.inject || [];
        let missingDeps = [];
        for (const dep of dependencies) {
            // 依赖可以是作用域服务，也可以是已安装的插件（仅约束顺序）。
            if (!(this.rootScope.has(dep)) && !(this.plugins.has(dep as string))) {
                missingDeps.push(dep);
                continue;
            }
        }
        if (missingDeps.length > 0) {
            this.logger.log('plugin', 'warn', `Plugin ${pluginModule.name}: Dependency ${missingDeps.join(', ')} missing when intalling`);
        }
        this.plugins.set(pluginModule.name, {
            name: pluginModule.name,
            module: pluginModule,
            context: undefined,
            config: undefined,
            enabled: false
        });
        // 监听插件声明的依赖：根作用域上同名服务被 provide 覆盖时联动重启。
        // 插件名形式的依赖不会被 provide 触发，登记无害。
        for (const dep of dependencies) {
            this.watchDependency(dep as string);
        }
        this.logger.log('plugin', 'info', `+ ${pluginModule.name}`);
    }

    async apply(name: string) {
        const plugin = this.plugins.get(name);
        if (!plugin) {
            this.logger.log('plugin', 'error', `Cannot apply plugin ${name}: not found`);
            return;
        }
        if (plugin.enabled) {
            this.logger.log('plugin', 'error', `Plugin ${name} is already applied`);
            return;
        }
        const dependencies = plugin.module.inject || [];
        const injections: Record<string, any> = {};
        let missingDeps = [];
        for (const dep of dependencies) {
            if (this.rootScope.has(dep)) {
                injections[dep] = this.rootScope.get(dep);
                continue;
            }
            // 插件间依赖仅约束启动顺序，无服务实例可注入。
            if (this.plugins.has(dep as string)) continue;
            missingDeps.push(dep);
        }
        if (missingDeps.length > 0) {
            this.logger.log('plugin', 'error', `Cannot apply plugin ${name}: Dependency ${missingDeps.join(', ')} not found`);
            return;
        }
        const pluginConfig = (this.config.get('plugin.config') as Record<string, any>) || {};
        const currentConfig = pluginConfig[name] || {};
        const scope = this.rootScope.fork();
        // 注入的服务登记到插件的子作用域：插件通过 `context.get()` 沿作用域链读取，
        // 兄弟插件不可见，插件卸载时随子作用域一并释放。
        for (const [dep, service] of Object.entries(injections)) {
            scope.set(dep, service);
        }
        const context = new PluginContext(scope, injections, currentConfig, this.bots, this.sharedEventListeners);
        try {
            await plugin.module.default(context);
            this.plugins.set(name, {
                ...plugin,
                context,
                config: currentConfig,
                enabled: true
            });
            await context.start();
        } catch (error) {
            await context.dispose();
            this.plugins.set(name, {
                ...plugin,
                context: undefined,
                config: undefined,
                enabled: false
            });
            throw error;
        }
        this.logger.log('plugin', 'info', `A ${name}`);
    }

    async dispose(name: string) {
        const plugin = this.plugins.get(name);
        if (!plugin) {
            this.logger.log('plugin', 'error', `Cannot dispose plugin ${name}: not found`);
            return;
        }
        if (!plugin.enabled) {
            this.logger.log('plugin', 'error', `Plugin ${name} is not enabled, dispose skipped`);
            return;
        }
        try {
            await plugin.context!.dispose();
        } finally {
            this.plugins.set(name, {
                ...plugin,
                enabled: false
            });
            this.logger.log('plugin', 'info', `D ${name}`);
        }
    }

    async remove(name: string) {
        const plugin = this.plugins.get(name);
        if (!plugin) {
            this.logger.log('plugin', 'error', `Cannot remove plugin ${name}: not found`);
            return;
        }
        if (plugin.enabled) {
            await this.dispose(name);
        }
        for (const dep of plugin.module.inject || []) {
            this.unwatchDependency(dep as string);
        }
        this.plugins.delete(name);
        this.logger.log('plugin', 'info', `- ${name}`);
    }

    private watchDependency(name: string) {
        const existing = this.replaceWatchers.get(name);
        if (existing) {
            existing.count += 1;
            return;
        }
        const off = this.rootScope.onReplace(name, (changed) => this.restartDependents(changed));
        this.replaceWatchers.set(name, { count: 1, off });
    }

    private unwatchDependency(name: string) {
        const existing = this.replaceWatchers.get(name);
        if (!existing) return;
        existing.count -= 1;
        if (existing.count <= 0) {
            existing.off();
            this.replaceWatchers.delete(name);
        }
    }

    /**
     * 服务替换后的联动重启（吸收 main 的 rollback 理念，改为显式可等待实现）：
     * 受影响集合为 inject 直接依赖该服务的插件，以及传递依赖这些插件的插件；
     * 按依赖拓扑逆序停止、正序重启，全部完成后才返回。
     * 诊断无效的插件保持停用；单个插件失败不阻断其余重启，最终汇总失败。
     */
    private async restartDependents(changed: string) {
        const affected = new Set<string>();
        let grew = true;
        while (grew) {
            grew = false;
            for (const [name, plugin] of this.plugins) {
                if (affected.has(name)) continue;
                const deps = plugin.module.inject || [];
                if (deps.some((dep) => dep === changed || affected.has(dep as string))) {
                    affected.add(name);
                    grew = true;
                }
            }
        }

        const enabled = (name: string) => this.plugins.get(name)?.enabled === true;
        const restartOrder = pluginDependencyDiagnose(this, this.rootScope).order
            .filter((name) => affected.has(name) && enabled(name));
        const stopOrder = [...restartOrder].reverse();
        // 诊断未入序列（如存在依赖问题）但已启用的受影响插件，排在最后兜底停止，
        // 且不参与重启，保持停用状态。
        for (const name of affected) {
            if (enabled(name) && !restartOrder.includes(name)) {
                stopOrder.push(name);
            }
        }

        const errors: unknown[] = [];
        for (const name of stopOrder) {
            try {
                await this.dispose(name);
            } catch (error) {
                errors.push(error);
                this.logger.log('plugin', 'error', `Failed to stop plugin ${name} for service ${changed} replacement.`, error);
            }
        }
        for (const name of restartOrder) {
            try {
                await this.apply(name);
            } catch (error) {
                errors.push(error);
                this.logger.log('plugin', 'error', `Failed to restart plugin ${name} for service ${changed} replacement.`, error);
            }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, `Failed to restart plugins for service ${changed} replacement.`);
    }

    map() {
        let list: Map<string, {
            enabled: boolean;
            inject?: readonly (keyof ServiceRegistry)[];
        }> = new Map();
        this.plugins.forEach((plugin) => {
            list.set(plugin.name, {
                enabled: plugin.enabled,
                inject: plugin.module.inject
            })
        })
        return list;
    }
}
