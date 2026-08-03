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
        if (this.state === LifecycleState.STOPPED || this.state === LifecycleState.FAILED) {
            throw new Error(`Cannot register a cleanup handler after lifecycle is ${this.state}.`);
        }
        this.cleanups.push(callback);
        return () => this.remove(this.cleanups, callback);
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

        this.state = LifecycleState.STOPPING;
        this.stopTask = this.runStop();
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

    private async runStop() {
        try {
            await this.disposeAll();
            this.state = LifecycleState.STOPPED;
        } catch (error) {
            this.state = LifecycleState.FAILED;
            throw error;
        }
    }

    private async disposeAfterFailure() {
        try {
            await this.disposeAll();
        } catch {
            // Preserve the startup error as the public failure reason.
        }
    }

    private async disposeAll() {
        const errors: unknown[] = [];
        while (this.cleanups.length > 0) {
            const cleanup = this.cleanups.pop()!;
            try {
                await cleanup();
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Multiple lifecycle cleanup handlers failed.');
    }

    private assertPending(operation: string) {
        if (this.state !== LifecycleState.PENDING) {
            throw new Error(`Cannot ${operation} while lifecycle is ${this.state}.`);
        }
    }

    private remove<T>(items: T[], item: T) {
        const index = items.indexOf(item);
        if (index !== -1) items.splice(index, 1);
    }
}
