export class Lifecycle {
    public disposals = new Set<Function>();

    constructor() {}

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

    fork() {
        const forked = new Lifecycle();
        this.collect(() => {
            forked.dispose();
        });
        return forked;
    }
}