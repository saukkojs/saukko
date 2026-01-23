import { Context } from "./context";

export class Lifecycle {
    public disposals = new Set<Function>();
    public children = new Set<Lifecycle>();

    constructor(private ctx: Context) {}

    collect(callback: () => any) {
        const dispose = () => {
            this.disposals.delete(dispose);
            return callback()
        }
        this.disposals.add(dispose);
        return dispose;
    }

    dispose() {
        const disposals = Array.from(this.disposals);
        this.disposals.clear();
        return Promise.all(disposals.map(fn => fn()));
    }

    fork(ctx?: Context) {
        const forked = new Lifecycle(ctx || this.ctx);
        this.children.add(forked);
        this.collect(() => {
            forked.dispose();
        });
        return forked;
    }
}