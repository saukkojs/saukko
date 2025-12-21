import { Bot } from "./bot";
import { PluginDependenciesRegistry, Events, Event } from "./types";

export class PluginContext {
    private eventListeners: Map<string, Function[]> = new Map();

    constructor(
        public readonly dependencies: PluginDependenciesRegistry,
        public readonly config: Map<string, any>,
        public bots: Array<Bot>
    ) { }

    private disposeGenerator(event: string, listener: Function) {
        return () => {
            const listeners = this.eventListeners.get(event);
            if (!listeners) return;
            const index = listeners.indexOf(listener);
            if (index !== -1) {
                listeners.splice(index, 1);
            }
        }
    }

    on<T extends keyof Events>(event: T, listener: (event: Event<T>) => void) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event)!.push(listener);

        return this.disposeGenerator(event, listener);
    }

    off<T extends keyof Events>(event: T, listener: (event: Event<T>) => void) {
        const listeners = this.eventListeners.get(event);
        if (!listeners) return;
        const index = listeners.indexOf(listener);
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    }

    emit<T extends keyof Events>(event: T, args: Event<T>) {
        const listeners = this.eventListeners.get(event);
        if (!listeners) return;
        for (const listener of listeners) {
            listener(args);
        }
    }

    mountBot(bot: Bot) {
        this.bots.push(bot);
    }
}
