import { LoggerService } from "./services/logger";
import { ConfigService } from "./services/config";
import { App } from "./app";

type Constructor<T = any> = {
    new(...args: any[]): T;
    inject?: readonly (keyof ServiceRegistry)[];
};

export interface ServiceRegistry {
    logger: LoggerService;
    config: ConfigService;
    app: App;
}

export class Container {
    private factories = new Map<string, () => any>();
    private instances = new Map<string, any>();
    private creating = new Set<string>();

    register<K extends keyof ServiceRegistry>(
        name: K,
        target: Constructor<ServiceRegistry[K]> | (() => ServiceRegistry[K])
    ) {
        if (typeof target === 'function' && target.prototype) {
            const Class = target as Constructor<ServiceRegistry[K]>;
            this.factories.set(name, () => {
                const deps = Class.inject || [];
                const injected = deps.map(dep => this.get(dep));
                return new Class(...injected);
            });
        } else {
            this.factories.set(name, target as () => ServiceRegistry[K]);
        }
    }

    get<K extends keyof ServiceRegistry>(name: K): ServiceRegistry[K] {
        if (this.creating.has(name)) {
            throw new Error(`Circular dependency detected: ${name}`);
        }

        if (this.instances.has(name)) {
            return this.instances.get(name);
        }

        this.creating.add(name);

        try {
            const factory = this.factories.get(name);
            if (!factory) {
                throw new Error(`Service ${name} not registered`);
            }

            const instance = factory();
            this.instances.set(name, instance);
            return instance;
        } finally {
            this.creating.delete(name);
        }
    }
}