import { Context } from "./context";
import { Lifecycle } from "./lifecycle";

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
    apply: Function;
    config: Record<string, any> | undefined;
    lifecycle: Lifecycle;
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
        ): Promise<() => Promise<void>>;
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

    /**
     * @use `ctx.use`
     */
    async use(plugin: Plugin, config: Record<string, any> = {}) {
        const apply = this.resolve(plugin);
        if (!apply) {
            throw new Error(
                "插件格式不正确：必须是函数、类或包含 apply 方法的对象，得到 " +
                typeof plugin
            );
        }

        // 如果插件已经注册，直接返回卸载函数
        if (this.plugins.has(plugin)) {
            const existing = this.plugins.get(plugin)!;
            return async () => {
                await existing.lifecycle.dispose();
                this.plugins.delete(plugin);
            };
        }

        // 创建生命周期并进行初始化
        const lifecycle = new Lifecycle(this.ctx, plugin, apply, config);
        
        const runtime: PluginRuntime = {
            name: plugin.name
                ? plugin.name == "apply"
                    ? undefined
                    : plugin.name
                : undefined,
            apply,
            config,
            lifecycle
        };

        this.plugins.set(plugin, runtime);

        // 尝试启动插件（检查依赖并启动）
        try {
            await lifecycle.load();
        } catch (error) {
            console.warn(`插件启动失败:`, error);
        }

        // 返回卸载函数
        return async () => {
            const pluginData = this.plugins.get(plugin);
            if (pluginData) {
                await pluginData.lifecycle.dispose();
                this.plugins.delete(plugin);
            }
        };
    }
}
