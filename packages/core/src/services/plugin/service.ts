import { Container, ServiceRegistry } from "../../container";
import { ConfigService } from "../config";
import { LoggerService } from "../logger";
import { PluginContext } from "./context";

interface PluginType {
    inject?: readonly (keyof ServiceRegistry)[];
    name: string;
    default: (context: PluginContext) => void;
}

interface PluginMapItem {
    name: string;
    module: PluginType;
    context: PluginContext | undefined;
    config: Record<string, any> | undefined;
    enabled: boolean;
}

export class PluginService {
    static inject = ['container', 'logger', 'config'] as const;
    private plugins = new Map<string, PluginMapItem>();

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

    apply(name: string) {
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
        const context = new PluginContext(injections, currentConfig);
        plugin.module.default(context);
        this.plugins.set(name, {
            ...plugin,
            context,
            config: currentConfig,
            enabled: true
        });
        context.emit('internal.ready', {});
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
        plugin.context!.emit('internal.dispose', {});
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

    list() {
        return Array.from(this.plugins.keys());
    }
}