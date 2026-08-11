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
    /** 依赖就绪、主体执行后才存在；等待依赖期间为 undefined。 */
    context: PluginContext | undefined;
    config: Record<string, any> | undefined;
    /** 实际运行中（子作用域生命周期 ACTIVE）。 */
    enabled: boolean;
    /** 期望启用：enable 标记；依赖就绪且主体执行完成后自动启动。 */
    desired: boolean;
    /** 当前缺失的依赖清单；为空表示依赖就绪。 */
    missing: string[];
}

export class PluginService {
    private plugins = new Map<string, PluginMapItem>();
    private bots: Array<Bot> = [];
    private sharedEventListeners: SharedEventListeners = new Map();
    private readonly rootScope: Scope;
    private readonly watchers = new Map<string, { count: number; offReplace: () => void; offAdd: () => void; offRemove: () => void }>();

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
     * 安装插件：依赖就绪则派生子作用域并**立即执行插件主体**
     * （注册钩子、监听与服务提升均在此时完成）；依赖缺失则挂起主体，
     * 插件进入"等待依赖"状态，依赖补齐后自动执行。
     * enable/disable 只是触发子作用域生命周期的 start/stop 开关，主体不会重复执行。
     * 主体执行失败时销毁子作用域且不留记录，重试即重新 install。
     */
    async install(plugin: PluginLike) {
        const pluginModule = this.resolvePlugin(plugin);
        if (this.plugins.has(pluginModule.name)) {
            this.logger.log('plugin', 'error', `Plugin ${pluginModule.name} is already installed`);
            this.logger.log('plugin', 'notice', 'In current version, creating multiple instances for a plugin is not supported.');
            return;
        }
        const item: PluginMapItem = {
            name: pluginModule.name,
            module: pluginModule,
            context: undefined,
            config: undefined,
            enabled: false,
            desired: false,
            missing: this.computeMissing(pluginModule),
        };
        if (item.missing.length === 0) {
            // 依赖就绪：立即执行主体；失败时销毁子作用域、不登记插件记录。
            await this.mount(item);
        }
        this.plugins.set(item.name, item);
        // 监听插件声明的依赖：服务被 provide 新增时解除等待，被覆盖时联动重启。
        // 插件名形式的依赖不会被 provide 触发，登记无害。
        for (const dep of pluginModule.inject || []) {
            this.watchDependency(dep as string);
        }
        if (item.missing.length > 0) {
            this.logger.log('plugin', 'info', `Plugin ${item.name} installed, waiting for dependencies: ${item.missing.join(', ')}`);
        }
        this.logger.log('plugin', 'info', `+ ${item.name}`);
        // 本插件的登记可能解除其他插件的等待（插件依赖以"已安装"为就绪判据）。
        await this.resolveWaiting();
    }

    /** 计算插件当前缺失的依赖：服务依赖看根作用域可读，插件依赖看已安装（记录存在）。 */
    private computeMissing(pluginModule: PluginType): string[] {
        const missing: string[] = [];
        for (const dep of pluginModule.inject || []) {
            if (!this.rootScope.has(dep) && !this.plugins.has(dep as string)) {
                missing.push(dep as string);
            }
        }
        return missing;
    }

    /** 执行插件主体：派生子作用域、构造 Context 并运行；失败时销毁子作用域并上抛。 */
    private async mount(plugin: PluginMapItem) {
        // 注入快照仅作兼容的 dependencies 记录；实际读取沿作用域父链完成，
        // 不写入子作用域（父链全量可读已覆盖，且服务替换后读取始终最新）。
        const injections: Record<string, any> = {};
        for (const dep of plugin.module.inject || []) {
            if (this.rootScope.has(dep)) {
                injections[dep] = this.rootScope.get(dep);
            }
        }
        const pluginConfig = (this.config.get('plugin.config') as Record<string, any>) || {};
        const currentConfig = pluginConfig[plugin.name] || {};
        const scope = this.rootScope.fork();
        const context = new PluginContext(scope, injections, currentConfig, this.bots, this.sharedEventListeners, plugin.name);
        try {
            await plugin.module.default(context);
        } catch (error) {
            await scope.dispose();
            throw error;
        }
        plugin.context = context;
        plugin.config = currentConfig;
    }

    /**
     * 依赖状态变化后的等待迁移：刷新全部插件的缺失清单，
     * 按诊断拓扑序执行就绪插件的挂起主体，并自动启动此前被标记为期望启用的插件。
     * 可等待；主体执行失败时摘除该插件记录（与 install 失败一致），失败汇总抛出。
     *
     * 可重入：插件主体经 `share` 提升服务会触发 onAdd 联动再次进入本方法，
     * 嵌套调用仅登记一次追加扫描，由外层循环统一收尾。
     */
    private resolveWaiting(): Promise<void> {
        if (this.resolving) {
            this.resolveQueued = true;
            return Promise.resolve();
        }
        this.resolving = true;
        return this.runResolveWaiting().finally(() => {
            this.resolving = false;
        });
    }

    private resolving = false;
    private resolveQueued = false;

    private async runResolveWaiting() {
        const errors: unknown[] = [];
        // 多轮扫描：挂载服务插件可能经 share 解除更多插件的等待（含嵌套触发的追加扫描）。
        let again = true;
        while (again) {
            again = false;
            this.resolveQueued = false;
            for (const plugin of this.plugins.values()) {
                plugin.missing = this.computeMissing(plugin.module);
            }
            // 诊断拓扑序只包含依赖就绪的插件：挂起主体的执行顺序同样服从拓扑。
            const ready = pluginDependencyDiagnose(this, this.rootScope).order;
            for (const name of ready) {
                const plugin = this.plugins.get(name);
                if (!plugin) continue;
                if (!plugin.context) {
                    try {
                        await this.mount(plugin);
                        this.logger.log('plugin', 'info', `Plugin ${name}: dependencies ready, mounted`);
                        // 主体可能提升了新服务：追加一轮扫描。
                        again = true;
                    } catch (error) {
                        errors.push(error);
                        this.logger.log('plugin', 'error', `Plugin ${name} failed to mount after dependencies became ready.`, error);
                        for (const dep of plugin.module.inject || []) {
                            this.unwatchDependency(dep as string);
                        }
                        this.plugins.delete(name);
                        continue;
                    }
                }
                if (plugin.desired && !plugin.enabled) {
                    try {
                        await plugin.context!.lifecycle.start();
                        plugin.enabled = true;
                        this.logger.log('plugin', 'info', `A ${name}`);
                    } catch (error) {
                        errors.push(error);
                        this.logger.log('plugin', 'error', `Plugin ${name} failed to start after dependencies became ready.`, error);
                    }
                }
            }
            if (this.resolveQueued) again = true;
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Failed to resume waiting plugins.');
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

    /**
     * 启用插件：依赖就绪则触发子作用域生命周期的 start（执行 onStart 钩子）；
     * 依赖缺失则标记为期望启用，依赖补齐后自动执行主体并启动。
     */
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
        plugin.desired = true;
        plugin.missing = this.computeMissing(plugin.module);
        if (plugin.missing.length > 0) {
            this.logger.log('plugin', 'info', `Plugin ${name} is expected to be enabled, waiting for dependencies: ${plugin.missing.join(', ')}`);
            return;
        }
        // 等待中解除但主体尚未执行（如依赖经 set/register 静默补齐）时补执行。
        if (!plugin.context) {
            await this.mount(plugin);
        }
        // 启动失败时生命周期进入 FAILED（清理已执行），插件保持未启用，可重试。
        await plugin.context!.lifecycle.start();
        plugin.enabled = true;
        this.logger.log('plugin', 'info', `A ${name}`);
    }

    /** 禁用插件：取消期望启用标记；已运行的触发子作用域生命周期的 stop，作用域不销毁。 */
    async dispose(name: string) {
        const plugin = this.plugins.get(name);
        if (!plugin) {
            this.logger.log('plugin', 'error', `Cannot dispose plugin ${name}: not found`);
            return;
        }
        plugin.desired = false;
        if (!plugin.enabled) {
            this.logger.log('plugin', 'error', `Plugin ${name} is not enabled, dispose skipped`);
            return;
        }
        try {
            await plugin.context!.lifecycle.stop();
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
        if (plugin.context) {
            await plugin.context.dispose();
        }
        for (const dep of plugin.module.inject || []) {
            this.unwatchDependency(dep as string);
        }
        this.plugins.delete(name);
        this.logger.log('plugin', 'info', `- ${name}`);
        // 被依赖的插件卸载后，其依赖方级联停止（等待重装恢复）。
        await this.cascadeDisable(name);
    }

    private watchDependency(name: string) {
        const existing = this.watchers.get(name);
        if (existing) {
            existing.count += 1;
            return;
        }
        const offReplace = this.rootScope.onReplace(name, (changed) => this.restartDependents(changed));
        const offAdd = this.rootScope.onAdd(name, () => this.resolveWaiting());
        const offRemove = this.rootScope.onRemove(name, (removed) => this.cascadeDisable(removed));
        this.watchers.set(name, { count: 1, offReplace, offAdd, offRemove });
    }

    private unwatchDependency(name: string) {
        const existing = this.watchers.get(name);
        if (!existing) return;
        existing.count -= 1;
        if (existing.count <= 0) {
            existing.offReplace();
            existing.offAdd();
            existing.offRemove();
            this.watchers.delete(name);
        }
    }

    /**
     * 依赖消失级联：依赖 lost 的已启用插件自动停止（传递依赖一并级联），
     * 按依赖拓扑逆序执行。自动停止**保留期望启用标记**——属于"等待依赖"而非用户
     * 主动禁用；依赖恢复（重新 share / 重新 install）后由等待迁移自动按拓扑正序重启。
     * 可等待；单个插件停止失败不阻断其余级联，失败汇总抛出。
     */
    private async cascadeDisable(lost: string) {
        const affected = new Set<string>();
        let grew = true;
        while (grew) {
            grew = false;
            for (const [name, plugin] of this.plugins) {
                if (affected.has(name)) continue;
                const deps = plugin.module.inject || [];
                if (deps.some((dep) => dep === lost || affected.has(dep as string))) {
                    affected.add(name);
                    grew = true;
                }
            }
        }
        if (affected.size === 0) return;

        // 依赖已消失，诊断序列不再包含受影响插件，停止顺序需自行推导：
        // 受影响子图上按"没有未停止的受影响依赖方"逐轮摘取（叶子优先），即拓扑逆序。
        const dependentsOf = new Map<string, Set<string>>();
        for (const name of affected) dependentsOf.set(name, new Set());
        for (const name of affected) {
            for (const dep of this.plugins.get(name)!.module.inject || []) {
                if (affected.has(dep as string)) dependentsOf.get(dep as string)!.add(name);
            }
        }
        const enabled = (name: string) => this.plugins.get(name)?.enabled === true;
        const pending = new Set([...affected].filter(enabled));
        const stopOrder: string[] = [];
        while (pending.size > 0) {
            const leaves = [...pending].filter((name) =>
                [...dependentsOf.get(name)!].every((dependent) => !pending.has(dependent)));
            // 循环依赖等异常形态兜底：按剩余顺序停止。
            if (leaves.length === 0) {
                stopOrder.push(...pending);
                break;
            }
            for (const leaf of leaves) {
                stopOrder.push(leaf);
                pending.delete(leaf);
            }
        }

        const errors: unknown[] = [];
        for (const name of stopOrder) {
            const plugin = this.plugins.get(name);
            if (!plugin || !plugin.context) continue;
            try {
                await plugin.context.lifecycle.stop();
                plugin.enabled = false;
                plugin.missing = this.computeMissing(plugin.module);
                this.logger.log('plugin', 'info', `Plugin ${name} auto-stopped: dependency ${lost} was removed, waiting for recovery.`);
            } catch (error) {
                errors.push(error);
                this.logger.log('plugin', 'error', `Failed to auto-stop plugin ${name} after dependency ${lost} was removed.`, error);
            }
        }
        // 未启用但受影响的插件同样刷新缺失清单（等待状态可诊断）。
        for (const name of affected) {
            const plugin = this.plugins.get(name);
            if (plugin && !plugin.enabled) {
                plugin.missing = this.computeMissing(plugin.module);
            }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, `Failed to cascade-stop plugins after ${lost} was removed.`);
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
            desired: boolean;
            missing: string[];
            inject?: readonly (keyof ServiceRegistry)[];
        }> = new Map();
        this.plugins.forEach((plugin) => {
            list.set(plugin.name, {
                enabled: plugin.enabled,
                desired: plugin.desired,
                missing: [...plugin.missing],
                inject: plugin.module.inject
            })
        })
        return list;
    }
}
