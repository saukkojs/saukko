import { Bot } from "./bot";
import { PluginDependenciesRegistry, Events, Event } from "./types";
import { Lifecycle } from "../../lifecycle";

export class PluginContext {
    private eventListeners: Map<string, Function[]> = new Map();
    private disposers: Array<() => void> = [];
    private disposed = false;
    private ready = false;
    public readonly lifecycle = new Lifecycle();

    constructor(
        public readonly dependencies: PluginDependenciesRegistry,
        public readonly config: Map<string, any>,
        public bots: Array<Bot>,
        private sharedEventListeners: Map<string, Function[]>
    ) {
        this.lifecycle.onStart(() => {
            this.ready = true;
            this.emit('internal.ready', {
                name: 'internal.ready',
                data: {}
            });
        });
        this.lifecycle.onStop(() => {
            this.disposed = true;
            for (const dispose of this.disposers.splice(0).reverse()) {
                dispose();
            }
        });
        this.lifecycle.onStop(() => {
            if (!this.ready) return;
            this.emit('internal.dispose', {
                name: 'internal.dispose',
                data: {}
            });
        });
    }

    private getListenerMap(event: string): Map<string, Function[]> {
        if (event === 'internal.ready' || event === 'internal.dispose') {
            return this.eventListeners;
        }
        return this.sharedEventListeners;
    }

    private disposeGenerator(event: string, listener: Function) {
        return () => {
            const map = this.getListenerMap(event);
            const listeners = map.get(event);
            if (!listeners) return;
            const index = listeners.indexOf(listener);
            if (index !== -1) {
                listeners.splice(index, 1);
                if (listeners.length === 0) {
                    map.delete(event);
                }
            }
        }
    }

    on<T extends keyof Events>(event: T, listener: (event: Event<T>) => void) {
        if (this.disposed) return () => {};
        const map = this.getListenerMap(event as string);
        if (!map.has(event as string)) {
            map.set(event as string, []);
        }
        map.get(event as string)!.push(listener);

        const dispose = this.disposeGenerator(event as string, listener);
        this.disposers.push(dispose);
        return dispose;
    }

    off<T extends keyof Events>(event: T, listener: (event: Event<T>) => void) {
        if (this.disposed) return;
        const map = this.getListenerMap(event as string);
        const listeners = map.get(event as string);
        if (!listeners) return;
        const index = listeners.indexOf(listener);
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    }

    emit<T extends keyof Events>(event: T, args: Event<T>) {
        if (this.disposed) return;
        const map = this.getListenerMap(event as string);
        const listeners = map.get(event as string);
        if (!listeners) return;
        for (const listener of listeners) {
            listener(args);
        }
    }

    start() {
        return this.lifecycle.start();
    }

    dispose() {
        return this.lifecycle.stop();
    }

    mountBot(bot: Bot) {
        this.bots.push(bot);
    }
}
