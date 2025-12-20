import { PluginDepenciesRegistry } from "./types";

export class PluginContext {
    public isEnabled: boolean = false;
    private eventListeners: Map<string, Function[]> = new Map();

    constructor(public readonly depencies: PluginDepenciesRegistry) { }

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

    on(event: string, listener: Function) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event)!.push(listener);

        return this.disposeGenerator(event, listener);
    }

    once(event: string, listener: Function) {
        const onceListener = (...args: any[]) => {
            listener(...args);
            dispose();
        };
        const dispose = this.on(event, onceListener);
        return dispose;
    }

    off(event: string, listener: Function) {
        const listeners = this.eventListeners.get(event);
        if (!listeners) return;
        const index = listeners.indexOf(listener);
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    }

    emit(event: string, ...args: any[]) {
        const listeners = this.eventListeners.get(event);
        if (!listeners) return;
        for (const listener of listeners) {
            listener(...args);
        }
    }
}
