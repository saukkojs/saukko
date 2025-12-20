import { PluginDepenciesRegistry } from "./types";

export class PluginContext {
    public isEnabled: boolean = false;

    constructor(public readonly depencies: PluginDepenciesRegistry) { }
}

