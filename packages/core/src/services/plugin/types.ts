import type { Bot } from "./bot";

export interface PluginDependenciesRegistry { };
export interface Events {}
export type Event<T extends keyof Events> = {
    name: T;
    data: Events[T];
    bot?: Bot;
};

export type EventListener<T extends keyof Events> = (event: Event<T>) => void;
