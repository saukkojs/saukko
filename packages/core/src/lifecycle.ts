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
}

export class Lifecycle {
    private readonly starts: LifecycleStart[] = [];
    private readonly beforeStops: LifecycleCleanup[] = [];
    private readonly cleanups: LifecycleCleanup[] = [];
    private startTask?: Promise<void>;
    private stopTask?: Promise<void>;

    public state = LifecycleState.PENDING;

    onStart(callback: LifecycleStart): () => void {
        this.assertPending('register a start handler');
        this.starts.push(callback);
        return () => this.remove(this.starts, callback);
    }

    onStop(callback: LifecycleCleanup): () => void {
        this.assertNotStopped('register a cleanup handler');
        this.cleanups.push(callback);
        return () => this.remove(this.cleanups, callback);
    }

    onBeforeStop(callback: LifecycleCleanup): () => void {
        this.assertNotStopped('register a stop notification handler');
        this.beforeStops.push(callback);
        return () => this.remove(this.beforeStops, callback);
    }

    start(): Promise<void> {
        if (this.state === LifecycleState.ACTIVE) return Promise.resolve();
        if (this.state === LifecycleState.STARTING) return this.startTask!;
        this.assertPending('start');

        this.state = LifecycleState.STARTING;
        this.startTask = this.runStart();
        return this.startTask;
    }

    stop(): Promise<void> {
        if (this.state === LifecycleState.STOPPED) return Promise.resolve();
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

    private async runStart() {
        try {
            for (const callback of [...this.starts]) {
                const cleanup = await callback();
                if (cleanup) this.cleanups.push(cleanup);
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
        errors.push(...await this.disposeAll());
        if (errors.length === 0) {
            this.state = LifecycleState.STOPPED;
            return;
        }
        this.state = LifecycleState.FAILED;
        this.throwErrors(errors, 'Multiple lifecycle stop handlers failed.');
    }

    private async disposeAfterFailure() {
        await this.disposeAll();
    }

    private async runBeforeStops() {
        return this.runCallbacks([...this.beforeStops].reverse());
    }

    private async disposeAll() {
        const callbacks: LifecycleCleanup[] = [];
        while (this.cleanups.length > 0) {
            callbacks.push(this.cleanups.pop()!);
        }
        return this.runCallbacks(callbacks);
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

    private assertPending(operation: string) {
        if (this.state !== LifecycleState.PENDING) {
            throw new Error(`Cannot ${operation} while lifecycle is ${this.state}.`);
        }
    }

    private assertNotStopped(operation: string) {
        if (this.state === LifecycleState.STOPPED || this.state === LifecycleState.FAILED) {
            throw new Error(`Cannot ${operation} after lifecycle is ${this.state}.`);
        }
    }

    private remove<T>(items: T[], item: T) {
        const index = items.indexOf(item);
        if (index !== -1) items.splice(index, 1);
    }
}
