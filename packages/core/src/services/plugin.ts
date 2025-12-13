import { Container, ServiceRegistry } from "../container";
import { LoggerService } from "./logger";

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

export class PluginService {
    static inject = ['container', 'logger'] as const;
    private plugins = new Map<string, PluginMapItem>();

    constructor(
        private container: Container,
        private logger: LoggerService
    ) {}
    
    apply(pluginModule: PluginType) {
        const dependencies = pluginModule.inject || [];
        const injections = dependencies.map(dep => this.container.get(dep));
        // WIP
    }

    remove(name: string) {
        // WIP
    }

    list() {
        return Array.from(this.plugins.keys());
    }
}