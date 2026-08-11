import { Awaitable, Lifecycle, LifecycleState } from './lifecycle';
import type { ServiceRegistry } from './types';

/**
 * 服务的生命周期约定（可选实现）。
 *
 * 通过 `Scope.provide` 登记的服务若实现本约定：
 * `start` 随作用域生命周期的启动序列调用，`stop` 随停止序列调用（按登记逆序）。
 */
export interface ScopedService {
    start?(): Awaitable<void>;
    stop?(): Awaitable<void>;
}

/**
 * `Scope.register` 接受的服务目标：带可选静态 `inject` 声明的构造函数，或工厂函数。
 * 构造函数的 `inject` 依赖在实例化时沿注册作用域的父链解析。
 */
export type ScopeServiceConstructor<T = unknown> = {
    new (...args: any[]): T;
    inject?: readonly string[];
};
export type ScopeServiceFactory<T = unknown> = ScopeServiceConstructor<T> | (() => T);

/**
 * 作用域：Context 资源的归属单元，构成一棵显式的父子层级树。
 *
 * 语义约定：
 * - 父作用域读取：`get`/`has` 先查本作用域登记的资源，未命中时沿 `parent` 链向上查找。
 *   读取是逐层显式委托，不依赖 JavaScript 原型链（不使用 Proxy 或 `Object.create()` 隐式继承）。
 * - 子作用域资源归属：`set` 登记的资源归属于登记时所在的作用域；
 *   子作用域的登记不会污染父作用域，作用域销毁时只释放自己登记的资源。
 * - 显式销毁：`dispose()` 是唯一的销毁入口，可等待且幂等；
 *   销毁顺序为先子后父（子作用域按创建逆序销毁），再执行本作用域的生命周期清理。
 */
export interface Scope {
    /** 父作用域；根作用域为 `undefined`。作用域销毁后与父作用域脱离。 */
    readonly parent: Scope | undefined;

    /**
     * 本作用域的生命周期。
     * 清理钩子通过 `onStop`/`onBeforeStop` 登记，随作用域销毁执行（`onBeforeStop` 早于 `onStop`）。
     */
    readonly lifecycle: Lifecycle;

    /** 沿父链查找资源是否已登记。 */
    has(name: string): boolean;

    /** 沿父链读取资源；未登记返回 `undefined`。键命中 `ServiceRegistry` 时返回注册表类型。 */
    get<K extends keyof ServiceRegistry>(name: K): ServiceRegistry[K] | undefined;
    get<T = unknown>(name: string): T | undefined;

    /**
     * 将资源登记到本作用域（覆盖本作用域的同名登记，不影响父作用域）。
     * 纯登记、无副作用；需要生命周期管理的服务请使用 `provide`。
     * 作用域销毁后调用会抛错。
     */
    set<T>(name: string, value: T): void;

    /**
     * 登记一个服务（返回该服务）。服务实现 `ScopedService` 约定时：
     * - `start` 挂到本作用域生命周期的启动序列；作用域已 ACTIVE 时登记则立即启动，
     *   本方法等待启动完成后返回。
     * - `stop` 挂到本作用域生命周期的停止序列，按登记逆序执行；
     *   启动失败的服务不会收到 `stop`。
     * 作用域生命周期为 STARTING/STOPPING/STOPPED/FAILED 时调用会抛错。
     *
     * 覆盖本作用域的同名登记时（含遮蔽 `register` 的惰性注册）：
     * 先摘除旧服务的生命周期钩子并等待其 `stop`，再登记新服务，
     * 最后依次等待本作用域 `onReplace` 监听器完成（服务联动重启的挂载点）。
     */
    provide<T>(name: string, service: T): Promise<T>;

    /**
     * 监听本作用域指定资源的新增登记：当该名称由未登记变为已登记时触发，
     * 按登记顺序逐个等待监听器完成。返回取消监听的函数。
     * 仅 `provide` 触发；`set`/`register` 保持纯登记语义，不触发联动；
     * 覆盖已有登记走 `onReplace` 而非本监听。作用域销毁后监听自动失效。
     */
    onAdd(name: string, listener: (name: string) => Awaitable<void>): () => void;

    /**
     * 监听本作用域指定资源的替换：`provide` 覆盖本作用域同名已登记资源时，
     * 新服务就绪后按登记顺序逐个等待监听器完成。返回取消监听的函数。
     * 仅 `provide` 触发；`set`/`register` 保持纯登记语义，不触发联动。
     * 作用域销毁后监听自动失效。
     */
    onReplace(name: string, listener: (name: string) => Awaitable<void>): () => void;

    /**
     * 惰性注册一个服务。
     * 首次 `get` 时才实例化并缓存到本作用域；构造函数的 `inject` 依赖沿父链解析；
     * 同作用域内的循环依赖会抛错。惰性实例不做生命周期管理，
     * 需要 `start`/`stop` 约定的服务请使用 `provide`。
     * 作用域销毁后调用会抛错。
     */
    register<T>(name: string, target: ScopeServiceFactory<T>): void;

    /** 列出沿父链可见的全部登记名。 */
    list(): string[];

    /**
     * 创建归属于本作用域的子作用域。
     * 子作用域随父作用域销毁而销毁，且先于父作用域自身的生命周期清理。
     * 作用域销毁后调用会抛错。
     */
    fork(): Scope;

    /**
     * 显式销毁本作用域：先按创建逆序销毁全部子作用域，
     * 再执行本作用域生命周期清理，最后从父作用域脱离。
     * 可等待、幂等；单个清理失败不阻断其余清理，最终汇总失败。
     */
    dispose(): Promise<void>;
}

/**
 * Context：绑定到某个作用域的使用者视图。
 *
 * 插件等使用方拿到的是 Context 而非作用域本身：
 * 读取与资源登记委托给所绑定的（子）作用域，作用域的创建与销毁由宿主（如应用/插件服务）控制。
 */
export interface Context {
    /** 本 Context 绑定的作用域。 */
    readonly scope: Scope;

    /** 等价于 `scope.lifecycle`；用于登记清理钩子与观察状态。 */
    readonly lifecycle: Lifecycle;

    /** 委托给 `scope.has`。 */
    has(name: string): boolean;

    /** 委托给 `scope.get`。键命中 `ServiceRegistry` 时返回注册表类型。 */
    get<K extends keyof ServiceRegistry>(name: K): ServiceRegistry[K] | undefined;
    get<T = unknown>(name: string): T | undefined;

    /** 委托给 `scope.set`；登记的资源归属于本 Context 绑定的作用域。 */
    set<T>(name: string, value: T): void;

    /** 委托给 `scope.provide`；服务归属于本 Context 绑定的作用域。 */
    provide<T>(name: string, service: T): Promise<T>;

    /** 委托给 `scope.register`；服务归属于本 Context 绑定的作用域。 */
    register<T>(name: string, target: ScopeServiceFactory<T>): void;

    /** 委托给 `scope.list`。 */
    list(): string[];
}

/**
 * `Scope` 的默认实现。
 *
 * 父链读取通过逐层显式委托完成，不使用 Proxy 或 `Object.create()` 隐式继承；
 * 子作用域由 `fork()` 创建并登记到父作用域，销毁时按创建逆序先于父作用域清理。
 */
class ScopeNode implements Scope {
    private readonly resources = new Map<string, unknown>();
    private readonly factories = new Map<string, () => unknown>();
    private readonly creating = new Set<string>();
    private readonly providedServices = new Map<string, {
        stop: () => Promise<void>;
        offStart?: () => void;
        offStop?: () => void;
    }>();
    private readonly addListeners = new Map<string, Array<(name: string) => Awaitable<void>>>();
    private readonly replaceListeners = new Map<string, Array<(name: string) => Awaitable<void>>>();
    private readonly children: ScopeNode[] = [];
    private parentNode: ScopeNode | undefined;
    private disposeTask: Promise<void> | undefined;

    public readonly lifecycle = new Lifecycle();

    constructor(parent?: ScopeNode) {
        this.parentNode = parent;
        parent?.children.push(this);
    }

    get parent(): Scope | undefined {
        return this.parentNode;
    }

    has(name: string): boolean {
        if (this.resources.has(name) || this.factories.has(name)) return true;
        return this.parentNode?.has(name) ?? false;
    }

    get<T = unknown>(name: string): T | undefined {
        if (this.resources.has(name)) return this.resources.get(name) as T;
        if (this.factories.has(name)) return this.instantiate<T>(name);
        return this.parentNode?.get<T>(name);
    }

    list(): string[] {
        const names = new Set<string>();
        for (const name of this.resources.keys()) names.add(name);
        for (const name of this.factories.keys()) names.add(name);
        for (const name of this.parentNode?.list() ?? []) names.add(name);
        return [...names];
    }

    set<T>(name: string, value: T): void {
        this.assertAlive('register a resource');
        this.resources.set(name, value);
    }

    register<T>(name: string, target: ScopeServiceFactory<T>): void {
        this.assertAlive('register a service');
        if (typeof target === 'function' && target.prototype) {
            const Class = target as ScopeServiceConstructor<T>;
            this.factories.set(name, () => {
                const deps = Class.inject || [];
                const injected = deps.map(dep => this.get(dep));
                return new Class(...injected);
            });
        } else {
            this.factories.set(name, target as () => T);
        }
    }

    private instantiate<T>(name: string): T {
        if (this.creating.has(name)) {
            throw new Error(`Circular dependency detected: ${name}`);
        }
        this.creating.add(name);
        try {
            const instance = this.factories.get(name)!() as T;
            this.resources.set(name, instance);
            return instance;
        } finally {
            this.creating.delete(name);
        }
    }

    async provide<T>(name: string, service: T): Promise<T> {
        this.assertAlive('provide a service');
        const state = this.lifecycle.state;
        if (state !== LifecycleState.PENDING && state !== LifecycleState.ACTIVE) {
            throw new Error(`Cannot provide a service while scope lifecycle is ${state}.`);
        }

        const replacing = this.resources.has(name) || this.factories.has(name);
        // 覆盖同名服务：先摘除旧服务的生命周期钩子并等待其停止，避免旧钩子在
        // 作用域销毁时重复触发，也保证旧服务先于联动重启释放。
        const previous = this.providedServices.get(name);
        if (previous) {
            previous.offStart?.();
            previous.offStop?.();
            this.providedServices.delete(name);
            await previous.stop();
        }
        this.factories.delete(name);
        this.resources.set(name, service);

        const hooks = service as ScopedService | null | undefined;
        const hasStart = typeof hooks?.start === 'function';
        const hasStop = typeof hooks?.stop === 'function';
        if (hasStart || hasStop) {
            // 没有 start 的服务视为“始终已启动”，保证 stop 一定会被调用。
            let started = !hasStart;
            const startService = async () => {
                await hooks!.start!();
                started = true;
            };
            const stopService = async () => {
                if (!started || !hasStop) return;
                started = false;
                await hooks!.stop!();
            };
            const entry: {
                stop: () => Promise<void>;
                offStart?: () => void;
                offStop?: () => void;
            } = { stop: stopService };
            if (hasStop) entry.offStop = this.lifecycle.onStop(stopService);
            if (state === LifecycleState.PENDING) {
                if (hasStart) entry.offStart = this.lifecycle.onStart(startService);
            } else if (hasStart) {
                // 作用域已 ACTIVE：立即启动并等待完成。
                await startService();
            }
            this.providedServices.set(name, entry);
        }

        if (replacing) await this.notifyReplace(name);
        else await this.notifyAdd(name);
        return service;
    }

    onAdd(name: string, listener: (name: string) => Awaitable<void>): () => void {
        this.assertAlive('watch a service addition');
        let listeners = this.addListeners.get(name);
        if (!listeners) {
            listeners = [];
            this.addListeners.set(name, listeners);
        }
        listeners.push(listener);
        return () => {
            const index = listeners.indexOf(listener);
            if (index !== -1) listeners.splice(index, 1);
        };
    }

    onReplace(name: string, listener: (name: string) => Awaitable<void>): () => void {
        this.assertAlive('watch a service replacement');
        let listeners = this.replaceListeners.get(name);
        if (!listeners) {
            listeners = [];
            this.replaceListeners.set(name, listeners);
        }
        listeners.push(listener);
        return () => {
            const index = listeners.indexOf(listener);
            if (index !== -1) listeners.splice(index, 1);
        };
    }

    private async notifyAdd(name: string) {
        const listeners = this.addListeners.get(name);
        if (!listeners || listeners.length === 0) return;
        const errors: unknown[] = [];
        for (const listener of [...listeners]) {
            try {
                await listener(name);
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Multiple service addition listeners failed.');
    }

    private async notifyReplace(name: string) {
        const listeners = this.replaceListeners.get(name);
        if (!listeners || listeners.length === 0) return;
        const errors: unknown[] = [];
        for (const listener of [...listeners]) {
            try {
                await listener(name);
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Multiple service replacement listeners failed.');
    }

    fork(): Scope {
        this.assertAlive('fork a child scope');
        return new ScopeNode(this);
    }

    dispose(): Promise<void> {
        if (!this.disposeTask) {
            this.disposeTask = this.runDispose();
        }
        return this.disposeTask;
    }

    private async runDispose(): Promise<void> {
        const errors: unknown[] = [];
        for (const child of [...this.children].reverse()) {
            try {
                await child.dispose();
            } catch (error) {
                errors.push(error);
            }
        }
        try {
            await this.lifecycle.dispose();
        } catch (error) {
            errors.push(error);
        }
        this.resources.clear();
        this.providedServices.clear();
        this.addListeners.clear();
        this.replaceListeners.clear();
        this.detach();
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Multiple scope cleanup handlers failed.');
    }

    private detach() {
        if (!this.parentNode) return;
        const siblings = this.parentNode.children;
        const index = siblings.indexOf(this);
        if (index !== -1) siblings.splice(index, 1);
        this.parentNode = undefined;
    }

    private assertAlive(operation: string) {
        if (this.disposeTask) {
            throw new Error(`Cannot ${operation} after scope is disposed.`);
        }
    }
}

/**
 * 创建一个作用域。`parent` 缺省时创建根作用域；
 * 传入父作用域时等价于 `parent.fork()`，要求父作用域同样由 `createScope` 创建。
 */
export function createScope(parent?: Scope): Scope {
    if (parent !== undefined && !(parent instanceof ScopeNode)) {
        throw new Error('createScope: parent must be a scope created by createScope().');
    }
    return new ScopeNode(parent);
}
