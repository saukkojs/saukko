import { Bot } from "./bot";
import { PluginDependenciesRegistry, Events, Event, EventListener } from "./types";
import { Context, Scope, ScopeServiceFactory } from "../../scope";
import { LifecycleState } from "../../lifecycle";
import type { ServiceRegistry } from "../../types";

/** 带属主的事件监听：分发时按属主插件的生命周期状态门控。 */
export interface OwnedEventListener {
    owner: PluginContext;
    listener: EventListener<keyof Events>;
}

/** 插件间共享的事件监听表，由 PluginService 持有并分发给各插件 Context。 */
export type SharedEventListeners = Map<string, OwnedEventListener[]>;

export class PluginContext implements Context {
    constructor(
        public readonly scope: Scope,
        public readonly dependencies: PluginDependenciesRegistry,
        public readonly config: Map<string, any>,
        public bots: Array<Bot>,
        private sharedEventListeners: SharedEventListeners,
        /** 插件名：share 缺省服务名；由 PluginService 挂载时传入。 */
        public readonly pluginName?: string
    ) {}

    get lifecycle() {
        return this.scope.lifecycle;
    }

    /** 终态判定：作用域生命周期进入 DISPOSED 后，事件读写与登记一律拒绝/忽略。 */
    private get disposed() {
        return this.lifecycle.state === LifecycleState.DISPOSED;
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

    /**
     * 将服务提升到根作用域（"服务即插件"）：缺省服务名为插件名；
     * 显式不同名时消费方需分别声明依赖。详见 `Scope.share`。
     */
    share<T>(service: T): Promise<T>;
    share<T>(name: string, service: T): Promise<T>;
    share<T>(nameOrService: string | T, service?: T): Promise<T> {
        if (typeof nameOrService === 'string') {
            return this.scope.share(nameOrService, service as T);
        }
        if (!this.pluginName) {
            throw new Error('Cannot share a service without an explicit name: the context is not bound to a plugin.');
        }
        return this.scope.share(this.pluginName, nameOrService);
    }

    list() {
        return this.scope.list();
    }

    private disposeGenerator(event: string, entry: OwnedEventListener) {
        return () => {
            const listeners = this.sharedEventListeners.get(event);
            if (!listeners) return;
            const index = listeners.indexOf(entry);
            if (index !== -1) {
                listeners.splice(index, 1);
                if (listeners.length === 0) {
                    this.sharedEventListeners.delete(event);
                }
            }
        }
    }

    on<T extends keyof Events>(event: T, listener: EventListener<T>) {
        if (this.disposed) return () => {};
        const entry: OwnedEventListener = { owner: this, listener: listener as EventListener<keyof Events> };
        let listeners = this.sharedEventListeners.get(event as string);
        if (!listeners) {
            listeners = [];
            this.sharedEventListeners.set(event as string, listeners);
        }
        listeners.push(entry);

        const dispose = this.disposeGenerator(event as string, entry);
        // 监听清理绑定终态销毁：disable（stop）不摘除监听，仅门控分发；
        // 重新 enable 后监听自动恢复，uninstall（dispose）时才真正移除。
        const unbind = this.lifecycle.onDispose(dispose);
        return () => {
            unbind();
            dispose();
        };
    }

    off<T extends keyof Events>(event: T, listener: EventListener<T>) {
        if (this.disposed) return;
        const listeners = this.sharedEventListeners.get(event as string);
        if (!listeners) return;
        const index = listeners.findIndex(
            (entry) => entry.owner === this && entry.listener === (listener as EventListener<keyof Events>)
        );
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    }

    emit<T extends keyof Events>(event: T, args: Event<T>) {
        if (this.disposed) return;
        const listeners = this.sharedEventListeners.get(event as string);
        if (!listeners) return;
        for (const { owner, listener } of [...listeners]) {
            // 门控：仅 ACTIVE 属主接收事件；disabled/停止中的插件不接收。
            if (owner.lifecycle.state !== LifecycleState.ACTIVE) continue;
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
