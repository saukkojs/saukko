import { Bot } from "./bot";

export interface PluginDependenciesRegistry { };
export interface Events {
    'internal.ready': {};
    'internal.dispose': {};
};
export type Event<T extends keyof Events> = {
    name: T;
    data: Events[T];
    bot?: Bot;
};