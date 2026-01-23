import symbols from "../symbols";
import { isNullish } from "../utils";
import { Context } from "./context";

declare module './context' {
    interface Context {
        /**
         * 在 Context 上声明一个服务
         * @param key 服务的名称
         * @param value 可选，提供服务的初始值
         */
        declare(key: string, value?: any): void;

        /**
         * 设置一个服务的值
         * 
         * 如果服务未被声明，则会先声明该服务
         * 
         * 已经被设置过的服务，不能被重复设置，除非先将值设为 `null` 或 `undefined` 来删除该服务
         * @param key 服务的名称
         * @param value 服务的值，如果为 `null` 或 `undefined`，则表示删除该服务
         */
        set(key: string, value: any): void;

        /**
         * 提升 Context 上某个服务或属性下的方法（或属性）到 Context
         * @param key 服务或属性的名称
         * @param methods 要提升的方法名，可以是字符串数组或键值对对象：如传入键值对对象，则键为提升后的名称，值为原名称
         */
        elevate(key: string, methods: string[] | Record<string, string>): void;

        /**
         * 解析一个被提升到 Context 的方法（或属性）
         * @param method 要解析的方法名
         * @return 返回一个包含服务（或属性）名称和原方法（或属性）名称的元组，若该方法未被提升，则返回 `undefined`
         */
        resolve(method: string): [string, string] | undefined;
    }
}

export class ProviderService {
    constructor(private ctx: Context) {
        this.elevate("provider", ["declare", "set", "elevate", "resolve"]);
        this.elevate("plugin", ["use"]);
        this.elevate("events", ["on", "off", "emit"]);
    }

    set(key: string, value: any = undefined) {
        if (!this.ctx[symbols.provider.store].has(key)) {
            this.ctx[symbols.provider.store].set(key, undefined);
        }
        const old = this.ctx[symbols.provider.store].get(key);
        if (old === value) return;  // ignore if same
        if (!isNullish(value) && !isNullish(old)) {
            throw new Error(`service "${key}" is already set.`);
        }
        this.ctx[symbols.provider.store].set(key, value);
        this.ctx.emit('internal.runtime', key);
    }

    elevate(key: string, methods: string[] | Record<string, string>) {
        if (Array.isArray(methods)) {
            methods = Object.fromEntries(methods.map(m => [m, m]));
        }
        for (const [method, target] of Object.entries(methods)) {
            if (this.ctx[symbols.provider.elevations].has(method)) {
                this.ctx.emit('internal.log', 'provider', 'warn', `method "${method}" is already elevated. overwriting.`);
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
            const resolution = ctx[symbols.provider.elevations].get(prop);
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
            const resolution = ctx[symbols.provider.elevations].get(prop);
            if (resolution) {
                ctx.emit('internal.log', 'provider', 'warn', `trying to set an elevated property "${prop}". overwriting.`);
                const [key, method] = resolution;
                if (key in ctx) {
                    // FIXME wrong type
                    //@ts-ignore
                    ctx[key][method] = value;
                    return true;
                }
                ctx.emit('internal.log', 'provider', 'warn', `failed to set elevated property "${prop}" because service "${key}" does not exist.`);
                return false;
            }

            // check if service
            if (ctx[symbols.provider.store].has(prop)) {
                ctx.emit('internal.log', 'provider', 'warn', `trying to set a property standing for service "${prop}". overwriting.`);
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
                return !isNullish(target[symbols.provider.store].get(prop));
            }
            // check if elevated property
            const resolution = target[symbols.provider.elevations].get(prop);
            if (resolution) {
                const [key, method] = resolution;
                const service = target[symbols.provider.store].get(key);
                if (!service) return false;
                return method in service;
            }
            return false;
        }
    }
}
