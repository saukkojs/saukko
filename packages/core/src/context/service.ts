import { Awaitable } from "../utils";
import { Context } from "./context";

export abstract class Service {
    /**
     * 构造一个服务实例
     * @param ctx 上下文实例
     * @param name 服务名称（被用于注册上下文）
     * @param immediate 是否立即启动该服务，默认为 `false` ，在没有依赖的情况下适用
     */
    constructor(
        protected ctx: Context,
        protected name: string,
        protected immediate: boolean = false
    ) {
        ctx.declare(name);
        
        if (immediate) {
            ctx.set(name, this);
            this.start();
        }
        else {
            ctx.on('internal.ready', () => {
                ctx.set(name, this);
                this.start();
            })
        }

        ctx.on('internal.dispose', () => {
            this.stop();
        })
    }

    protected start(): Awaitable<void> {}
    protected stop(): Awaitable<void> {}
}