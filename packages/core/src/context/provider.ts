import { Context } from "./context";

export class ProviderService {
    private services: Map<string, any> = new Map();
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
}
