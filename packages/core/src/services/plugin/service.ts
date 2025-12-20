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
    context: PluginContext;
    config: Record<string, any>;
}

export class PluginService {
    static inject = ['container', 'logger', 'config'] as const;
    private plugins = new Map<string, PluginMapItem>();

    constructor(
        private container: Container,
        private logger: LoggerService,
        private config: ConfigService
    ) { }

    apply(pluginModule: PluginType) {
        const dependencies = pluginModule.inject || [];
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
            this.logger.log('plugin', 'error', `Cannot apply plugin ${pluginModule.name}: Dependency ${missingDeps.join(', ')} not found`);
            return;
        }
        const pluginConfig = (this.config.get('plugin.config') as Record<string, any>) || {};
        const currentConfig = pluginConfig[pluginModule.name] || {};
        const context = new PluginContext(injections, currentConfig);
        pluginModule.default(context);
        this.plugins.set(pluginModule.name, {
            name: pluginModule.name,
            module: pluginModule,
            context,
            config: currentConfig
        });
        context.emit('internal.ready', {});
        this.logger.log('plugin', 'info', `+ ${pluginModule.name}`);
    }

    remove(name: string) {
        const plugin = this.plugins.get(name);
        if (!plugin) {
            this.logger.log('plugin', 'error', `Cannot remove plugin ${name}: not found`);
            return;
        }
        plugin.context.emit('internal.dispose', {});
        this.plugins.delete(name);
        this.logger.log('plugin', 'info', `- ${name}`);
    }

    list() {
        return Array.from(this.plugins.keys());
    }
}