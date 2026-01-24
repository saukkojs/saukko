import { Context } from "./context";
import symbols from "./symbols";
import { Awaitable, isNullish } from "./utils";

export enum LifecycleState {
    PENDING = 0,
    LOADING = 1,
    ACTIVE = 2,
    UNLOADING = 3,
    DISPOSED = 4,
    FAILED = 5
}

export class Lifecycle {
    public assurances = new Set<() => Awaitable<any>>();
    public disposals = new Set<() => Awaitable<any>>();
    public children = new Set<Lifecycle>();
    public state: LifecycleState = LifecycleState.PENDING;

    constructor(private ctx: Context, private inject: Array<string> = []) {}

    private collapse() {
        const disposals = Array.from(this.disposals);
        disposals.forEach(fn => (async () => fn())().catch((e: any) => {
            this.ctx.emit('internal.log', 'lifecycle', 'warn', 'collapse got error: ', e);
        }));
    }

    private checkReady() {
        let ready = true;
        for (const name of this.inject) {
            if (!this.ctx[symbols.provider.store].has(name) || isNullish(this.ctx[symbols.provider.store].get(name))) {
                ready = false;
                break;
            }
        }
        return ready;
    }

    setup() {
        if (this.state !== LifecycleState.PENDING) return;
        if (!this.checkReady()) return;

        this.state = LifecycleState.LOADING;

        const assurances = Array.from(this.assurances);
        assurances.forEach(fn => (async () => fn())().catch((e: any) => {
            this.ctx.emit('internal.log', 'lifecycle', 'warn', 'setup got error: ', e);
            this.state = LifecycleState.FAILED;
        }));
        
        this.state = LifecycleState.ACTIVE;
        
    }

    collect<T>(callback: () => T) {
        const dispose = () => {
            this.disposals.delete(dispose);
            return callback()
        }
        this.disposals.add(dispose);
        return dispose;
    }

    ensure(callback: () => Awaitable<any>) {
        if (this.state === LifecycleState.LOADING || this.state === LifecycleState.ACTIVE) {
            (async () => callback())().catch((e: any) => {
                this.ctx.emit('internal.log', 'lifecycle', 'warn', 'ensure got error: ', e);
            });
        }
        this.assurances.add(callback);
    }

    dispose() {
        if (this.state === LifecycleState.DISPOSED || this.state === LifecycleState.UNLOADING) return;
        this.state = LifecycleState.UNLOADING;
        this.collapse();
        this.state = LifecycleState.DISPOSED;
    }

    rollback() {
        if (this.state === LifecycleState.DISPOSED || this.state === LifecycleState.UNLOADING || this.state === LifecycleState.FAILED) return;
        this.state = LifecycleState.UNLOADING;
        this.collapse();
        this.state = LifecycleState.PENDING;
        this.setup();
    }

    fork(inject: Array<string> = []) {
        const forked = new Lifecycle(this.ctx, inject);
        this.children.add(forked);
        this.collect(() => {
            forked.dispose();
        });
        return forked;
    }
}