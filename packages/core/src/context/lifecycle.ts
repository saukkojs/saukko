import { Context } from "./context";
import { Plugin } from "./plugin";

export class Lifecycle {
    private disposals = new Set<() => void | Promise<void>>();
    private disposed = false;

    constructor(private ctx: Context, private plugin: Plugin) {}

    /**
     * 添加一个副作用清理函数
     * @param disposal 清理函数，支持同步和异步
     */
    addDisposal(disposal: () => void | Promise<void>): void {
        if (this.disposed) {
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
     * 检查是否已经被销毁
     */
    isDisposed(): boolean {
        return this.disposed;
    }

    /**
     * 销毁生命周期，清理所有副作用
     */
    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        
        this.disposed = true;
        
        // 并行执行所有清理函数，避免阻塞
        const promises: Promise<void>[] = [];
        
        for (const disposal of this.disposals) {
            try {
                const result = disposal();
                if (result && typeof result.then === 'function') {
                    promises.push(result);
                }
            } catch (error) {
                // 记录错误但继续执行其他清理函数
                console.error(`清理函数执行失败:`, error);
            }
        }

        // 等待所有异步清理完成
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
     * 创建一个子生命周期
     * 
     * 子生命周期销毁时不会影响父生命周期，但父生命周期销毁时会自动销毁所有子生命周期
     */
    createChild(): Lifecycle {
        const child = new Lifecycle(this.ctx, this.plugin);
        this.addDisposal(() => child.dispose());
        return child;
    }
}