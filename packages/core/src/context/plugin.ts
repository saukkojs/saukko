import { Lifecycle } from "../lifecycle";
import { Context } from "./context";

type PluginMeta = {
    name?: string;
    inject?: string[];
};

type PluginFunctionLike = (
    context: Context,
    config: Record<string, any>
) => void | Promise<void>;

type PluginClassLike = {
    new(context: Context, config: Record<string, any>): void;
};

type PluginObjectLike = {
    apply(context: Context, config: Record<string, any>): void | Promise<void>;
};

export type Plugin = PluginMeta &
    (PluginFunctionLike | PluginClassLike | PluginObjectLike);

type PluginRuntime = {
    name: string | undefined;
    config: Record<string, any> | undefined;
    lifecycle: Lifecycle;
    ctx: Context;
};

declare module './context' {
    interface Context {
        /**
         * 向 Context 挂载一个插件
         * 
         * 这里的插件可以是一个函数、类，或一个包含 apply 方法的对象
         * @param plugin 要挂载的插件
         * @param config 要传入的插件配置
         * @return 用于卸载该插件的异步函数
         */
        use(
            plugin: Plugin,
            config?: Record<string, any>
        ): () => void;
    }
}

export class PluginService {
    private plugins = new Map<Plugin, PluginRuntime>();

    constructor(private ctx: Context) {}

    private resolve(plugin: Plugin): Function | undefined {
        if (typeof plugin === "function") {
            if (/^class\s/.test(plugin.toString())) {
                return (ctx: Context, config: Record<string, any>) => {
                    new (plugin as PluginClassLike)(ctx, config);
                };
            }
            return plugin as PluginFunctionLike;
        }
        if (plugin.apply && typeof plugin.apply === "function") {
            return plugin.apply;
        }
    }

    /**
     * @use `ctx.use`
     */
    use(plugin: Plugin, config: Record<string, any> = {}) {
        const apply = this.resolve(plugin);
        if (!apply) {
            throw new Error(
                "插件格式不正确：必须是函数、类或包含 apply 方法的对象，得到 " +
                typeof plugin
            );
        }

        if (this.plugins.has(plugin)) {
            const existing = this.plugins.get(plugin)!;
            return () => existing.lifecycle.dispose();
        }

        const lifecycle = this.ctx.lifecycle.fork(plugin.inject || []);
        const context = this.ctx.extend({
            lifecycle
        });
        
        const runtime: PluginRuntime = {
            name: plugin.name
                ? plugin.name == "apply"
                    ? undefined
                    : plugin.name
                : undefined,
            config,
            lifecycle,
            ctx: context
        };

        this.plugins.set(plugin, runtime);

        lifecycle.ensure(async () => await apply(context, config))
        lifecycle.setup();

        this.ctx.on('internal.runtime', (name) => {
            if (plugin.inject?.includes(name)) {
                lifecycle.rollback();
            }
        });

        return lifecycle.collect(() => {
            lifecycle.dispose();
            this.plugins.delete(plugin);
        });
    }
}
