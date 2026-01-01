import { Container, ServiceRegistry } from "../../container";
import { ConfigService } from "../config";
import { LoggerService } from "../logger";
import { Bot } from "./bot";
import { PluginContext } from "./context";

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
    private sharedEventListeners = new Map<string, Function[]>();

    constructor(
        private container: Container,
        private logger: LoggerService,
        private config: ConfigService
    ) { }

    install(pluginModule: PluginType) {
        if (this.plugins.has(pluginModule.name)) {
            this.logger.log('plugin', 'error', `Plugin ${pluginModule.name} is already installed`);
            this.logger.log('plugin', 'notice', 'In current version, creating multiple instances for a plugin is not supported.');
            return;
        }
        const dependencies = pluginModule.inject || [];
        let missingDeps = [];
        for (const dep of dependencies) {
            if (!(this.container.has(dep))) {
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
            if (!(this.container.has(dep))) {
                missingDeps.push(dep);
                continue;
            }
            injections[dep] = this.container.get(dep);
        }
        if (missingDeps.length > 0) {
            this.logger.log('plugin', 'error', `Cannot apply plugin ${name}: Dependency ${missingDeps.join(', ')} not found`);
            return;
        }
        const pluginConfig = (this.config.get('plugin.config') as Record<string, any>) || {};
        const currentConfig = pluginConfig[name] || {};
        const context = new PluginContext(injections, currentConfig, this.bots, this.sharedEventListeners);
        await plugin.module.default(context);
        this.plugins.set(name, {
            ...plugin,
            context,
            config: currentConfig,
            enabled: true
        });
        context.emit('internal.ready', {
            name: 'internal.ready',
            data: {}
        });
        this.logger.log('plugin', 'info', `A ${name}`);
    }

    dispose(name: string) {
        const plugin = this.plugins.get(name);
        if (!plugin) {
            this.logger.log('plugin', 'error', `Cannot dispose plugin ${name}: not found`);
            return;
        }
        if (!plugin.enabled) {
            this.logger.log('plugin', 'error', `Plugin ${name} is not enabled, dispose skipped`);
            return;
        }
        plugin.context!.emit('internal.dispose', {
            name: 'internal.dispose',
            data: {}
        });
        plugin.context!.dispose();
        this.plugins.set(name, {
            ...plugin,
            enabled: false
        });
        this.logger.log('plugin', 'info', `D ${name}`);
    }

    remove(name: string) {
        const plugin = this.plugins.get(name);
        if (!plugin) {
            this.logger.log('plugin', 'error', `Cannot remove plugin ${name}: not found`);
            return;
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