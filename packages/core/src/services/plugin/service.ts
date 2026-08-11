import { ServiceRegistry } from "../../types";
import { createScope, Scope } from "../../scope";
// 与 utils 存在模块级循环引用（utils 的 injectionProvider 构造 PluginService）；
// pluginDependencyDiagnose 是函数声明，模块实例化阶段即完成提升，运行时调用安全。
import { pluginDependencyDiagnose } from "../../utils";
import { ConfigService } from "../config";
import { LoggerService } from "../logger";
import { Bot } from "./bot";
import { PluginContext, SharedEventListeners } from "./context";

type AsyncAble<T> = T | Promise<T>;

/** 插件的执行体：接收插件 Context，可异步。 */
export type PluginApply = (context: PluginContext) => AsyncAble<void>;

/**
 * 插件的主路径形态：`{ name, default }` 模块。
 * daemon 的包加载器（loader）只接受该形态。
 */
export interface PluginType {
    inject?: readonly (keyof ServiceRegistry)[];
    name: string;
    default: PluginApply;
}

/** 函数形态：函数名即插件名，`inject` 作为函数的可选属性声明。 */
export type PluginFunction = PluginApply & {
    inject?: readonly (keyof ServiceRegistry)[];
};

/** 类形态：类名即插件名，挂载时以插件 Context 实例化（实例化即完成挂载）。 */
export type PluginClass = {
    new (context: PluginContext): void;
    inject?: readonly (keyof ServiceRegistry)[];
};

/** 对象形态：含 `apply` 方法；`name` 缺省时回退到 `apply` 的函数名。 */
export interface PluginObject {
    inject?: readonly (keyof ServiceRegistry)[];
    name?: string;
    apply: PluginApply;
}

/** `PluginService.install` 接受的全部插件形态。 */
export type PluginLike = PluginType | PluginFunction | PluginClass | PluginObject;

export interface PluginMapItem {
    name: string;
    module: PluginType;
    context: PluginContext;
    config: Record<string, any> | undefined;
    enabled: boolean;
}

export class PluginService {
    private plugins = new Map<string, PluginMapItem>();
    private bots: Array<Bot> = [];
    private sharedEventListeners: SharedEventListeners = new Map();
    private readonly rootScope: Scope;
    private readonly replaceWatchers = new Map<string, { count: number; off: () => void }>();

    constructor(
        private logger: LoggerService,
        private config: ConfigService,
        rootScope?: Scope
    ) {
        // 未显式传入时退化为独立空根（主要用于测试）；
        // 正常路径由 injectionProvider 传入应用根作用域。
        this.rootScope = rootScope ?? createScope();
    }

    /**
     * 安装插件：派生子作用域、构造 Context 并**立即执行插件主体**
     * （注册钩子、监听与服务提升均在此时完成）。enable/disable 只是
     * 触发子作用域生命周期的 start/stop 开关，主体不会重复执行。
     * 主体执行失败时销毁子作用域且不留记录，重试即重新 install。
     */
    async install(plugin: PluginLike) {
        const pluginModule = this.resolvePlugin(plugin);
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
        // 注入快照仅作兼容的 dependencies 记录；实际读取沿作用域父链完成，
        // 不再写入子作用域（父链全量可读已覆盖，且服务替换后读取始终最新）。
        const injections: Record<string, any> = {};
        for (const dep of dependencies) {
            if (this.rootScope.has(dep)) {
                injections[dep] = this.rootScope.get(dep);
            }
        }
        const pluginConfig = (this.config.get('plugin.config') as Record<string, any>) || {};
        const currentConfig = pluginConfig[pluginModule.name] || {};
        const scope = this.rootScope.fork();
        const context = new PluginContext(scope, injections, currentConfig, this.bots, this.sharedEventListeners);
        try {
            await pluginModule.default(context);
        } catch (error) {
            // 主体执行失败：销毁子作用域、不登记插件记录，重试即重新 install。
            await scope.dispose();
            throw error;
        }
        this.plugins.set(pluginModule.name, {
            name: pluginModule.name,
            module: pluginModule,
            context,
            config: currentConfig,
            enabled: false
        });
        // 监听插件声明的依赖：根作用域上同名服务被 provide 覆盖时联动重启。
        // 插件名形式的依赖不会被 provide 触发，登记无害。
        for (const dep of dependencies) {
            this.watchDependency(dep as string);
        }
        this.logger.log('plugin', 'info', `+ ${pluginModule.name}`);
    }

    /**
     * 将多形态插件归一化为 `{ name, inject, default }` 模块形态（吸收自 main）。
     * 名称解析：模块/对象形态取 `name` 属性，函数形态取函数名，类形态取类名；
     * 无法解析出名称时抛错。匿名类表达式与匿名函数同样没有名称。
     */
    private resolvePlugin(plugin: PluginLike): PluginType {
        if (typeof plugin === 'function') {
            // 类形态：以 class 关键字声明的构造函数；经转译的 ES5 类无法识别，按函数处理。
            if (/^class\s/.test(Function.prototype.toString.call(plugin))) {
                const Class = plugin as unknown as PluginClass;
                const resolved: PluginType = {
                    name: Class.name,
                    inject: Class.inject,
                    default: (context) => {
                        new Class(context);
                    },
                };
                if (!resolved.name) throw new Error('插件缺少可解析的名称（匿名类）');
                return resolved;
            }
            const fn = plugin as PluginFunction;
            if (!fn.name) throw new Error('插件缺少可解析的名称（匿名函数）');
            return { name: fn.name, inject: fn.inject, default: fn };
        }
        if (typeof plugin === 'object' && plugin !== null) {
            if ('default' in plugin && typeof plugin.default === 'function') {
                if (!plugin.name) throw new Error('插件缺少可解析的名称（模块形态需提供 name）');
                return plugin as PluginType;
            }
            if ('apply' in plugin && typeof plugin.apply === 'function') {
                const obj = plugin as PluginObject;
                const name = obj.name ?? (obj.apply.name !== 'apply' ? obj.apply.name : undefined);
                if (!name) throw new Error('插件缺少可解析的名称（对象形态需提供 name）');
                return {
                    name,
                    inject: obj.inject,
                    default: (context) => obj.apply(context),
                };
            }
        }
        throw new Error(`插件格式不正确：必须是 { name, default } 模块、函数、类或含 apply 方法的对象，得到 ${typeof plugin}`);
    }

    /** 启用插件：触发子作用域生命周期的 start（执行 onStart 钩子）。 */
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
        let missingDeps = [];
        for (const dep of dependencies) {
            if (this.rootScope.has(dep)) continue;
            // 插件间依赖仅约束启动顺序，无服务实例可注入。
            if (this.plugins.has(dep as string)) continue;
            missingDeps.push(dep);
        }
        if (missingDeps.length > 0) {
            this.logger.log('plugin', 'error', `Cannot apply plugin ${name}: Dependency ${missingDeps.join(', ')} not found`);
            return;
        }
        // 启动失败时生命周期进入 FAILED（清理已执行），插件保持未启用，可重试。
        await plugin.context.lifecycle.start();
        plugin.enabled = true;
        this.logger.log('plugin', 'info', `A ${name}`);
    }

    /** 禁用插件：触发子作用域生命周期的 stop（执行 onStop 钩子），作用域不销毁。 */
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
            await plugin.context.lifecycle.stop();
        } finally {
            plugin.enabled = false;
            this.logger.log('plugin', 'info', `D ${name}`);
        }
    }

    /** 卸载插件：先 disable（若启用），再终态销毁子作用域并摘除记录。 */
    async remove(name: string) {
        const plugin = this.plugins.get(name);
        if (!plugin) {
            this.logger.log('plugin', 'error', `Cannot remove plugin ${name}: not found`);
            return;
        }
        if (plugin.enabled) {
            await this.dispose(name);
        }
        await plugin.context.dispose();
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
