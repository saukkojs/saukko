import { PluginContext } from "./context";

export abstract class Bot {
    constructor(public context: PluginContext) { }
}