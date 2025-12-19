import { Container, ServiceRegistry } from "../container";
import { LoggerService } from "./logger";

export interface PluginDepenciesRegistry {};

interface PluginType {
    inject?: readonly (keyof ServiceRegistry)[];
    name: string;
    apply(context: any): void;
    dispose?(): void | Promise<void>;
}

interface PluginMapItem {
    name: string;
    module: PluginType;
    context: any;
}

class PluginContext {
    public isEnabled: boolean = false;

    constructor(public readonly depencies: PluginDepenciesRegistry) { }
}

export class PluginService {
    static inject = ['container', 'logger'] as const;
    private plugins = new Map<string, PluginMapItem>();

    constructor(
        private container: Container,
        private logger: LoggerService
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
            this.logger.log('plugin', 'error', `Cannot apply plugin ${pluginModule.name}: depency ${missingDeps.join(', ')} not found`);
            return;
        }
        const context = new PluginContext(injections);
        // WIP
    }

    remove(name: string) {
        // WIP
    }

    list() {
        return Array.from(this.plugins.keys());
    }
}