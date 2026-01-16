import { Context } from "./context";

export class ProviderService {
    private services: Map<string, any> = new Map();
    private elevations: Map<string, [string, string]> = new Map();
    constructor(private ctx: Context) {}

    provide(key: string, value: any) {
        if (this.services.has(key)) {
            throw new Error(`Service with key "${key}" is already provided.`);
        }
        this.services.set(key, value);
    }

    has(key: string) {
        return this.services.has(key);
    }

    get(key: string) {
        if (!this.services.has(key)) {
            throw new Error(`Service with key "${key}" is not provided.`);
        }
        return this.services.get(key);
    }

    remove(key: string) {
        if (!this.services.has(key)) {
            throw new Error(`Service with key "${key}" is not provided.`);
        }
        this.services.delete(key);
    }

    elevate(service: string, methods: string[] | Record<string, string>) {
        if (Array.isArray(methods)) {
            methods = Object.fromEntries(methods.map(m => [m, m]));
        }
        for (const [method, as] of Object.entries(methods)) {
            this.elevations.set(as, [service, method]);
        }
    }

    resolve(key: string) {
        return this.elevations.get(key);
    }
}
