import { LogType } from "@cocotais/logger";
import { Context } from "./context";

declare module './context' {
    interface Context {
        /**
         * 监听一个事件
         * @param event 事件名称
         * @param listener 事件监听器
         * @return 返回一个用于取消监听的函数
         */
        on<T extends keyof Events>(event: T, listener: Events[T]): () => any;

        /**
         * 取消监听一个事件
         * @param event 事件名称
         * @param listener 事件监听器
         */
        off<T extends keyof Events>(event: T, listener: Events[T]): void;

        /**
         * 触发一个事件
         * 
         * 调用时会依次调用所有监听该事件的监听器
         * @param event 事件名称
         * @param args 参数
         */
        emit<T extends keyof Events>(event: T, ...args: Parameters<Events[T]>): void;
    }
}

export interface Events {
    'internal.ready'(): void;
    'internal.dispose'(): void;
    'internal.log'(name: string, level: LogType, ...messages: any[]): void;
    'internal.runtime'(name: string): void;
}

export class EventsService {
    private eventListeners: Map<string, Function[]> = new Map();

    constructor(private ctx: Context) {}

    on(event: string, listener: Function) {
        if (event === 'internal.ready') {
            this.ctx.lifecycle.ensure(() => listener());
            return () => {};
        }
        if (event === 'internal.dispose') {
            let func = () => listener();
            this.ctx.lifecycle.collect(func);
            return this.ctx.lifecycle.collect(() => {
                this.ctx.lifecycle.disposals.delete(func);
            });
        }
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event)!.push(listener);

        return this.ctx.lifecycle.collect(() => {
            return this.off(event, listener);
        })
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