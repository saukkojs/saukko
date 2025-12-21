import { PluginContext } from "./context";
import { Events } from "./types";

export abstract class Bot {
    constructor(public context: PluginContext) { }
    protected emit<T extends keyof Events>(name:T, data: Events[T]) {
        this.context.emit(name, {
            name,
            data,
            bot: this
        })
    }
}