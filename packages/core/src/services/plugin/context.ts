import { PluginDependenciesRegistry, Events } from "./types";

export class PluginContext {
    public isEnabled: boolean = false;
    private eventListeners: Map<string, Function[]> = new Map();

    constructor(public readonly dependencies: PluginDependenciesRegistry) { }

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

    on<T extends keyof Events>(event: T, listener: Events[T]) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event)!.push(listener);

        return this.disposeGenerator(event, listener);
    }

    once<T extends keyof Events>(event: T, listener: Events[T]) {
        const onceListener = (...args: any[]) => {
            (listener as any)(...args);
            dispose();
        };
        const dispose = this.on(event, onceListener as unknown as Events[T]);
        return dispose;
    }

    off<T extends keyof Events>(event: T, listener: Events[T]) {
        const listeners = this.eventListeners.get(event);
        if (!listeners) return;
        const index = listeners.indexOf(listener);
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    }

    emit<T extends keyof Events>(event: T, ...args: Parameters<Events[T]>) {
        const listeners = this.eventListeners.get(event);
        if (!listeners) return;
        for (const listener of listeners) {
            listener(...args);
        }
    }
}
