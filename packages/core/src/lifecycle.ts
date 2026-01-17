export class Lifecycle {
    private disposals = new Set<Function>();

    constructor(private parent?: Lifecycle) {}

    collect(callback: () => any) {
        const dispose = () => {
            this.disposals.delete(dispose);
            return callback()
        }
        this.disposals.add(dispose);
        this.parent?.collect(dispose);
        return dispose;
    }

    dispose() {
        const disposals = Array.from(this.disposals);
        this.disposals.clear();
        return Promise.all(disposals.map(fn => fn()));
    }

    fork() {
        const forked = new Lifecycle(this);
        this.collect(() => {
            forked.dispose();
        });
        return forked;
    }
}