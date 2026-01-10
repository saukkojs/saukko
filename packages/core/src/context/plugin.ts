import { Context } from "./context";

type PluginMeta = {
    name?: string;
    inject?: string[];
};

type PluginFunctionLike = (
    context: Context,
    config: Record<string, any> | undefined
) => void | Promise<void>;

type PluginClassLike = {
    new(context: Context, config: Record<string, any> | undefined): void;
};

type PluginObjectLike = {
    apply(context: Context, config: Record<string, any> | undefined): void | Promise<void>;
};

type Plugin = PluginMeta &
    (PluginFunctionLike | PluginClassLike | PluginObjectLike);

type PluginRuntime = {
    name: string | undefined;
    apply: Function;
    config: Record<string, any> | undefined;
};

declare module './context' {
    interface Context {
        /**
         * 向 Context 挂载一个插件
         * 
         * 这里的插件可以是一个函数、类，或一个包含 apply 方法的对象
         * @param plugin 要挂载的插件
         * @param config 要传入的插件配置
         * @return 用于卸载该插件的函数
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
            return plugin;
        }
        if (plugin.apply && typeof plugin.apply === "function") {
            return plugin.apply;
        }
    }

    use(plugin: Plugin, config?: Record<string, any>) {
        const apply = this.resolve(plugin);
        if (!apply) {
            throw new Error(
                "插件格式不正确：必须是函数、类或包含 apply 方法的对象，得到 " +
                typeof plugin
            );
        }

        if (this.plugins.has(plugin)) {
            return () => {
                this.plugins.delete(plugin);
            };
        }

        if (plugin.inject) {
            const unmet = plugin.inject.filter(dep => !(dep in this.ctx))
            if (unmet.length > 0) {
                throw new Error(
                    `插件依赖未满足：${unmet.join(', ')}`
                );
            }
        }

        this.plugins.set(plugin, {
            name: plugin.name
                ? plugin.name == "apply"
                    ? undefined
                    : plugin.name
                : undefined,
            apply,
            config,
        });

        apply(this.ctx, config);

        return () => {
            this.plugins.delete(plugin);
        }
    }
}
