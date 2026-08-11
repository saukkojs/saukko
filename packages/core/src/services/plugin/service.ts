import { Container, ServiceRegistry } from "../../container";
import { createContainerScope, Scope } from "../../scope";
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
            if (!(this.rootScope.has(dep))) {
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
            if (!(this.rootScope.has(dep))) {
                missingDeps.push(dep);
                continue;
            }
            injections[dep] = this.rootScope.get(dep);
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
        this.plugins.delete(name);
        this.logger.log('plugin', 'info', `- ${name}`);
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
