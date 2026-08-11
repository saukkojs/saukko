import { Bot } from "./bot";
import { PluginDependenciesRegistry, Events, Event, EventListener } from "./types";
import { Context, Scope, ScopeServiceFactory } from "../../scope";
import type { ServiceRegistry } from "../../container";

export class PluginContext implements Context {
    private disposed = false;

    constructor(
        public readonly scope: Scope,
        public readonly dependencies: PluginDependenciesRegistry,
        public readonly config: Map<string, any>,
        public bots: Array<Bot>,
        private sharedEventListeners: Map<string, EventListener<keyof Events>[]>
    ) {
        this.lifecycle.onStop(() => {
            this.disposed = true;
        });
    }

    get lifecycle() {
        return this.scope.lifecycle;
    }

    has(name: string) {
        return this.scope.has(name);
    }

    get<K extends keyof ServiceRegistry>(name: K): ServiceRegistry[K] | undefined;
    get<T = unknown>(name: string): T | undefined;
    get<T = unknown>(name: string): T | undefined {
        return this.scope.get<T>(name);
    }

    set<T>(name: string, value: T) {
        this.scope.set(name, value);
    }

    provide<T>(name: string, service: T) {
        return this.scope.provide(name, service);
    }

    register<T>(name: string, target: ScopeServiceFactory<T>) {
        this.scope.register(name, target);
    }

    list() {
        return this.scope.list();
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
        // 监听清理直接绑定到子作用域的生命周期：
        // 作用域停止时按注册逆序自动移除监听，无需额外的私有清理列表。
        const unbind = this.lifecycle.onStop(dispose);
        return () => {
            unbind();
            dispose();
        };
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

    emit<T extends keyof Events>(event: T, args: Event<T>) {
        if (this.disposed) return;
        const listeners = this.sharedEventListeners.get(event as string);
        if (!listeners) return;
        for (const listener of [...listeners]) {
            listener(args as Event<keyof Events>);
        }
    }

    start() {
        return this.lifecycle.start();
    }

    dispose() {
        return this.scope.dispose();
    }

    mountBot(bot: Bot) {
        this.bots.push(bot);
    }
}
