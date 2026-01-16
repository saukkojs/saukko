import { Context } from "./context";

export class ProviderService {
    private services: Map<string, any> = new Map();
    private elevations: Map<string, [string, string]> = new Map();
    constructor(private ctx: Context) {}

    provide(key: string, value?: any) {
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

    set(key: string, value: any) {
        if (!this.services.has(key)) {
            throw new Error(`Service with key "${key}" is not provided.`);
        }
        this.services.set(key, value);
    }

    remove(key: string) {
        if (!this.services.has(key)) {
            throw new Error(`Service with key "${key}" is not provided.`);
        }
        this.services.delete(key);
    }

    elevate(key: string, methods: string[] | Record<string, string>) {
        if (Array.isArray(methods)) {
            methods = Object.fromEntries(methods.map(m => [m, m]));
        }
        for (const [method, as] of Object.entries(methods)) {
            this.elevations.set(as, [key, method]);
        }
    }

    resolve(key: string) {
        return this.elevations.get(key);
    }

    static handler: ProxyHandler<Context> = {
        get(target, prop, ctx: Context) {
            // 不处理 Symbol
            if (typeof prop !== "string") {
                return Reflect.get(target, prop, ctx);
            }

            // 不处理 Context 上已有的属性
            if (Reflect.has(target, prop)) {
                return Reflect.get(target, prop, ctx);
            }
            
            const resolution = ctx.provider.resolve(prop);
            if (resolution) {
                const [key, method] = resolution;
                if (ctx.provider.has(key)) {
                    const service = ctx.provider.get(key);
                    if (method in service) {
                        const value = service[method];
                        if (typeof value === "function") {
                            return value.bind(service);
                        }
                        return value;
                    }
                }
                return undefined;
            }

            if (ctx.provider.has(prop)) {
                return ctx.provider.get(prop);
            }

            return undefined;
        },
        set(target, prop, value, ctx: Context) {
            // 不处理 Symbol
            if (typeof prop !== "string") {
                return Reflect.set(target, prop, value, ctx);
            }

            if (ctx.provider.has(prop)) {
                ctx.provider.set(prop, value);
                return true;
            }

            if (ctx.provider.resolve(prop)) {
                throw new Error(`Cannot set elevated property "${prop}".`);
            }

            return Reflect.set(target, prop, value, ctx);
        },
        has(target, prop) {
            // 不处理 Symbol
            if (typeof prop !== "string") {
                return Reflect.has(target, prop);
            }
            if (Reflect.has(target, prop)) {
                return true;
            }
            if (target.provider.has(prop)) {
                return true;
            }
            if (target.provider.resolve(prop)) {
                return true;
            }
            return false;
        }
    }
}
