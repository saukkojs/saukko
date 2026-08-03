import { Bot } from "./bot";
import { PluginDependenciesRegistry, Events, Event, EventListener } from "./types";
import { Lifecycle } from "../../lifecycle";

export class PluginContext {
    private disposers: Array<() => void> = [];
    private disposed = false;
    public readonly lifecycle = new Lifecycle();

    constructor(
        public readonly dependencies: PluginDependenciesRegistry,
        public readonly config: Map<string, any>,
        public bots: Array<Bot>,
        private sharedEventListeners: Map<string, EventListener<keyof Events>[]>
    ) {
        this.lifecycle.onStop(() => {
            this.disposed = true;
            for (const dispose of this.disposers.splice(0).reverse()) {
                dispose();
            }
        });
    }

    private disposeGenerator<T extends keyof Events>(event: T, listener: EventListener<T>) {
        return () => {
            const listeners = this.sharedEventListeners.get(event as string);
            if (!listeners) return;
            const index = listeners.indexOf(listener as EventListener<keyof Events>);
            if (index !== -1) {
                listeners.splice(index, 1);
                if (listeners.length === 0) {
                    this.sharedEventListeners.delete(event as string);
                }
            }
        }
    }

    on<T extends keyof Events>(event: T, listener: EventListener<T>) {
        if (this.disposed) return () => {};
        if (!this.sharedEventListeners.has(event as string)) {
            this.sharedEventListeners.set(event as string, []);
        }
        this.sharedEventListeners.get(event as string)!.push(listener as EventListener<keyof Events>);

        const dispose = this.disposeGenerator(event, listener);
        this.disposers.push(dispose);
        return dispose;
    }

    off<T extends keyof Events>(event: T, listener: EventListener<T>) {
        if (this.disposed) return;
        const listeners = this.sharedEventListeners.get(event as string);
        if (!listeners) return;
        const index = listeners.indexOf(listener as EventListener<keyof Events>);
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    }

    async emit<T extends keyof Events>(event: T, args: Event<T>) {
        if (this.disposed) return;
        const listeners = this.sharedEventListeners.get(event as string);
        if (!listeners) return;
        for (const listener of [...listeners]) {
            await listener(args as Event<keyof Events>);
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
