import { Bot } from "./bot";
import { PluginDependenciesRegistry, Events, Event } from "./types";

export class PluginContext {
    private eventListeners: Map<string, Function[]> = new Map();
    private disposers: Array<() => void> = [];
    private disposed = false;

    constructor(
        public readonly dependencies: PluginDependenciesRegistry,
        public readonly config: Map<string, any>,
        public bots: Array<Bot>,
        private sharedEventListeners: Map<string, Function[]>
    ) { }

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

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const dispose of this.disposers) {
            dispose();
        }
    }

    mountBot(bot: Bot) {
        this.bots.push(bot);
    }
}
