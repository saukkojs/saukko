import symbols from "../symbols";
import { isNullish } from "../utils";
import { Context } from "./context";

export class ProviderService {
    constructor(private ctx: Context) {}

    declare(key: string, value?: any) {
        if (this.ctx[symbols.provider.store].has(key)) return;  // ignore if exists
        this.ctx[symbols.provider.store].set(key, value);
    }

    set(key: string, value: any) {
        this.declare(key);
        const old = this.ctx[symbols.provider.store].get(key);
        if (old === value) return;  // ignore if same
        if (!isNullish(value) && !isNullish(old)) {
            throw new Error(`service "${key}" is already set.`);
        }
        this.ctx[symbols.provider.store].set(key, value);
    }

    elevate(key: string, methods: string[] | Record<string, string>) {
        if (Array.isArray(methods)) {
            methods = Object.fromEntries(methods.map(m => [m, m]));
        }
        for (const [method, target] of Object.entries(methods)) {
            if (this.ctx[symbols.provider.elevations].has(method)) {
                // TODO warn
            }
            this.ctx[symbols.provider.elevations].set(method, [key, target]);
        }
    }

    resolve(method: string) {
        return this.ctx[symbols.provider.elevations].get(method);
    }

    static handler: ProxyHandler<Context> = {
        get(target, prop, ctx: Context) {
            // ignore if symbol
            if (typeof prop !== "string") {
                return Reflect.get(target, prop, ctx);
            }

            // ignore if own property
            if (Reflect.has(target, prop)) {
                return Reflect.get(target, prop, ctx);
            }
            
            // check if elevated property
            const resolution = ctx.provider.resolve(prop);
            if (resolution) {
                const [key, method] = resolution;
                if (key in ctx) {
                    // FIXME wrong type
                    //@ts-ignore
                    const value = ctx[key][method];

                    if (typeof value === "function") {
                        return value.bind(ctx[key]);
                    }
                    return value;
                }
                return undefined;
            }

            // check if service
            if (ctx[symbols.provider.store].has(prop)) {
                return ctx[symbols.provider.store].get(prop);
            }

            return undefined;
        },
        set(target, prop, value, ctx: Context) {
            // ignore if symbol
            if (typeof prop !== "string") {
                return Reflect.set(target, prop, value, ctx);
            }

            // check if elevated property
            const resolution = ctx.provider.resolve(prop);
            if (resolution) {
                // TODO warn
                const [key, method] = resolution;
                if (key in ctx) {
                    // FIXME wrong type
                    //@ts-ignore
                    ctx[key][method] = value;
                    return true;
                }
                return false;
            }

            // check if service
            if (ctx[symbols.provider.store].has(prop)) {
                // TODO warn
                ctx[symbols.provider.store].set(prop, value);
                return true;
            }

            return Reflect.set(target, prop, value, ctx);
        },
        has(target, prop) {
            // ignore if symbol
            if (typeof prop !== "string") {
                return Reflect.has(target, prop);
            }
            // check if own property
            if (Reflect.has(target, prop)) {
                return true;
            }
            // check if service
            if (target[symbols.provider.store].has(prop)) {
                return true;
            }
            // check if elevated property
            const resolution = target.provider.resolve(prop);
            if (resolution) {
                const [key, _] = resolution;
                if (key in target) {
                    return true;
                }
            }
            return false;
        }
    }
}
