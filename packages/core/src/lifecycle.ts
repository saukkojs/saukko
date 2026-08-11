export type Awaitable<T> = T | Promise<T>;

export type LifecycleCleanup = () => Awaitable<void>;
export type LifecycleStart = () => Awaitable<void | LifecycleCleanup>;

export enum LifecycleState {
    PENDING = 'pending',
    STARTING = 'starting',
    ACTIVE = 'active',
    STOPPING = 'stopping',
    STOPPED = 'stopped',
    FAILED = 'failed',
    DISPOSED = 'disposed',
}

/**
 * 生命周期：可复用的启动/停止状态机。
 *
 * - `onStart`/`onStop`/`onBeforeStop` 注册的钩子持久保留，可随 start/stop 反复触发：
 *   STOPPED 后可再次 `start()`（插件 enable/disable 开关的底座）。
 * - `onStart` 返回的清理回调属于当前启动周期，随下一次 stop 执行一次后移除。
 * - FAILED（启动/停止失败）后允许再次 `start()` 重试：失败时清理已执行，钩子仍可重跑。
 * - `dispose()` 是唯一的终态：执行停止流程与 `onDispose` 钩子后进入 DISPOSED，
 *   拒绝一切后续操作。
 */
export class Lifecycle {
    private readonly starts: LifecycleStart[] = [];
    private readonly beforeStops: LifecycleCleanup[] = [];
    private readonly stops: LifecycleCleanup[] = [];
    private readonly disposes: LifecycleCleanup[] = [];
    private cycleCleanups: LifecycleCleanup[] = [];
    private startTask?: Promise<void>;
    private stopTask?: Promise<void>;
    private disposeTask?: Promise<void>;

    public state = LifecycleState.PENDING;

    onStart(callback: LifecycleStart): () => void {
        this.assertStartable('register a start handler');
        this.starts.push(callback);
        return () => this.remove(this.starts, callback);
    }

    onStop(callback: LifecycleCleanup): () => void {
        this.assertNotTerminal('register a cleanup handler');
        this.stops.push(callback);
        return () => this.remove(this.stops, callback);
    }

    onBeforeStop(callback: LifecycleCleanup): () => void {
        this.assertNotTerminal('register a stop notification handler');
        this.beforeStops.push(callback);
        return () => this.remove(this.beforeStops, callback);
    }

    /**
     * 注册终态销毁钩子：仅在 `dispose()` 时按注册逆序执行一次。
     * 与 `onStop` 的区别：`onStop` 随每次 stop 反复触发，`onDispose` 只属于终态。
     * DISPOSED 后注册抛错；STOPPING/FAILED 中仍允许注册（销毁流程尚未完成）。
     */
    onDispose(callback: LifecycleCleanup): () => void {
        if (this.state === LifecycleState.DISPOSED) {
            throw new Error('Cannot register a dispose handler after lifecycle is disposed.');
        }
        this.disposes.push(callback);
        return () => this.remove(this.disposes, callback);
    }

    start(): Promise<void> {
        if (this.state === LifecycleState.ACTIVE) return Promise.resolve();
        if (this.state === LifecycleState.STARTING) return this.startTask!;
        this.assertStartable('start');

        this.state = LifecycleState.STARTING;
        this.startTask = this.runStart();
        return this.startTask;
    }

    stop(): Promise<void> {
        if (this.state === LifecycleState.STOPPED || this.state === LifecycleState.DISPOSED) {
            return Promise.resolve();
        }
        if (this.state === LifecycleState.STOPPING) return this.stopTask!;
        if (this.state === LifecycleState.STARTING) {
            return this.startTask!.then(() => this.stop(), () => Promise.resolve());
        }
        if (this.state === LifecycleState.FAILED) return Promise.resolve();

        const notify = this.state === LifecycleState.ACTIVE;
        this.state = LifecycleState.STOPPING;
        this.stopTask = this.runStop(notify);
        return this.stopTask;
    }

    /**
     * 终态销毁：执行停止流程后进入 DISPOSED。
     * 幂等；停止与销毁钩子的失败汇总抛出，但状态必定收敛为 DISPOSED。
     */
    dispose(): Promise<void> {
        if (!this.disposeTask) {
            this.disposeTask = this.runDispose();
        }
        return this.disposeTask;
    }

    private async runDispose() {
        const errors: unknown[] = [];
        try {
            await this.stop();
        } catch (error) {
            errors.push(error);
        }
        errors.push(...await this.runCallbacks([...this.disposes].reverse()));
        this.state = LifecycleState.DISPOSED;
        if (errors.length === 0) return;
        this.throwErrors(errors, 'Multiple lifecycle dispose handlers failed.');
    }

    private async runStart() {
        try {
            for (const callback of [...this.starts]) {
                const cleanup = await callback();
                if (cleanup) this.cycleCleanups.push(cleanup);
            }
            this.state = LifecycleState.ACTIVE;
        } catch (error) {
            await this.disposeAfterFailure();
            this.state = LifecycleState.FAILED;
            throw error;
        }
    }

    private async runStop(notify: boolean) {
        const errors: unknown[] = [];
        if (notify && this.beforeStops.length > 0) {
            errors.push(...await this.runBeforeStops());
        }
        errors.push(...await this.runStops());
        if (errors.length === 0) {
            this.state = LifecycleState.STOPPED;
            return;
        }
        this.state = LifecycleState.FAILED;
        this.throwErrors(errors, 'Multiple lifecycle stop handlers failed.');
    }

    private async disposeAfterFailure() {
        await this.runStops();
    }

    private async runBeforeStops() {
        return this.runCallbacks([...this.beforeStops].reverse());
    }

    private async runStops() {
        // 持久钩子按注册逆序执行并保留；周期清理执行一次后移除。
        const callbacks = [...this.stops].reverse();
        const cycle = this.cycleCleanups.reverse();
        this.cycleCleanups = [];
        return this.runCallbacks([...callbacks, ...cycle]);
    }

    private async runCallbacks(callbacks: LifecycleCleanup[]) {
        const errors: unknown[] = [];
        for (const callback of callbacks) {
            try {
                await callback();
            } catch (error) {
                errors.push(error);
            }
        }
        return errors;
    }

    private throwErrors(errors: unknown[], message: string): never {
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors, message);
    }

    private assertStartable(operation: string) {
        if (
            this.state !== LifecycleState.PENDING &&
            this.state !== LifecycleState.STOPPED &&
            this.state !== LifecycleState.FAILED
        ) {
            throw new Error(`Cannot ${operation} while lifecycle is ${this.state}.`);
        }
    }

    private assertNotTerminal(operation: string) {
        if (
            this.state === LifecycleState.STOPPING ||
            this.state === LifecycleState.FAILED ||
            this.state === LifecycleState.DISPOSED
        ) {
            throw new Error(`Cannot ${operation} after lifecycle is ${this.state}.`);
        }
    }

    private remove<T>(items: T[], item: T) {
        const index = items.indexOf(item);
        if (index !== -1) items.splice(index, 1);
    }
}
