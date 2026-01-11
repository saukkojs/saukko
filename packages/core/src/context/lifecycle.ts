import { Context } from "./context";
import { Plugin } from "./plugin";

export enum LifecycleStatus {
    /** 等待依赖或正在初始化 */
    PENDING = "pending",
    /** 依赖检查通过，正在加载 */
    LOADING = "loading",
    /** 已激活，正常运行 */
    ACTIVE = "active",
    /** 正在卸载回到等待状态 */
    UNLOADING = "unloading",
    /** 出现错误 */
    ERROR = "error",
    /** 已被销毁 */
    DISPOSED = "disposed",
}

export class Lifecycle {
    private disposals = new Set<() => void | Promise<void>>();
    private _status: LifecycleStatus = LifecycleStatus.PENDING;

    constructor(
        private ctx: Context,
        private plugin: Plugin,
        private apply: Function,
        private config: Record<string, any>
    ) { }

    /**
     * 获取生命周期状态
     */
    get status(): LifecycleStatus {
        return this._status;
    }

    /**
     * 添加一个副作用清理函数
     * @param disposal 清理函数
     */
    addDisposal(disposal: () => void | Promise<void>): void {
        if (this._status === LifecycleStatus.DISPOSED) {
            throw new Error("Lifecycle已经被销毁，不能添加新的清理函数");
        }
        this.disposals.add(disposal);
    }

    /**
     * 移除一个副作用清理函数
     * @param disposal 要移除的清理函数
     */
    removeDisposal(disposal: () => void | Promise<void>): boolean {
        return this.disposals.delete(disposal);
    }



    /**
     * 检查插件依赖是否满足
     */
    checkDeps(): boolean {
        if (this._status === LifecycleStatus.DISPOSED) {
            return false;
        }
        
        if (this.plugin.inject) {
            const unmet = this.plugin.inject.filter((dep) => !(dep in this.ctx));
            return unmet.length === 0;
        }
        
        // 没有依赖的插件认为依赖满足
        return true;
    }

    /**
     * 加载/重载生命周期，并自动根据依赖状态启动或卸载插件
     */
    async load(): Promise<void> {
        const depsAvailable = this.checkDeps();
        
        if (this._status === LifecycleStatus.PENDING && depsAvailable) {
            // 依赖可用，尝试启动
            await this._start();
        } else if (this._status === LifecycleStatus.ACTIVE && !depsAvailable) {
            // 依赖不可用，尝试卸载
            await this.unload();
        }
    }

    /**
     * 强制重置生命周期到 `PENDING` 状态
     * 
     * 这不会处理副作用
     */
    reset(): void {
        this._status = LifecycleStatus.PENDING;
    }

    /**
     * 更新插件配置并重新加载
     */
    async loadConfig(newConfig: Record<string, any>): Promise<void> {
        const oldConfig = this.config;
        this.config = newConfig;
        
        try {
            if (this._status === LifecycleStatus.ACTIVE) {
                // 如果当前激活，先卸载再重新加载
                await this.unload();
                await this._start();
            }
            // 如果在PENDING状态，无需操作，等待下次start时使用新配置
        } catch (error) {
            // 配置更新失败，恢复原配置
            this.config = oldConfig;
            throw error;
        }
    }

    /**
     * 处理错误状态，清理所有副作用
     */
    private async _handleError(): Promise<void> {
        await this._clearDisposals();
        this._status = LifecycleStatus.ERROR;
    }

    /**
     * 清理所有副作用
     */
    private async _clearDisposals(): Promise<void> {
        const promises: Promise<void>[] = [];
        
        for (const disposal of this.disposals) {
            try {
                const result = disposal();
                if (result && typeof result.then === "function") {
                    promises.push(result);
                }
            } catch (error) {
                console.error(`清理函数执行失败:`, error);
            }
        }
        
        if (promises.length > 0) {
            try {
                await Promise.allSettled(promises);
            } catch (error) {
                console.error(`异步清理函数执行失败:`, error);
            }
        }
        
        this.disposals.clear();
    }

    /**
     * 销毁生命周期，清理所有副作用
     */
    async dispose(): Promise<void> {
        if (this._status === LifecycleStatus.DISPOSED) {
            return;
        }
        
        // 清理所有副作用
        await this._clearDisposals();
        
        this._status = LifecycleStatus.DISPOSED;
    }

    /**
     * 启动插件
     */
    private async _start(): Promise<void> {
        if (this._status !== LifecycleStatus.PENDING) {
            throw new Error(`插件无法启动，当前状态: ${this._status}`);
        }
        
        // 检查依赖
        if (!this.checkDeps()) {
            throw new Error(`插件依赖未满足`);
        }
        
        // 设置为加载状态
        this._status = LifecycleStatus.LOADING;
        
        try {
            const result = this.apply(this.ctx, this.config);
            if (result && typeof result.then === "function") {
                await result;
            }
            // 初始化成功，标记为激活状态
            this._status = LifecycleStatus.ACTIVE;
        } catch (error) {
            // 初始化失败时标记为错误状态并清理副作用
            await this._handleError();
            throw error;
        }
    }

    /**
     * 卸载插件
     */
    async unload(): Promise<void> {
        if (this._status !== LifecycleStatus.ACTIVE) {
            throw new Error(`插件无法卸载，当前状态: ${this._status}`);
        }
        
        // 设置为卸载状态
        this._status = LifecycleStatus.UNLOADING;
        
        try {
            // 清理所有副作用
            await this._clearDisposals();
            // 卸载成功，返回PENDING状态
            this._status = LifecycleStatus.PENDING;
        } catch (error) {
            // 卸载失败时标记为错误状态
            await this._handleError();
            throw error;
        }
    }
}
