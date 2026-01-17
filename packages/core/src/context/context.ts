import { Lifecycle } from "../lifecycle";
import symbols from "../symbols";
import { PluginService } from "./plugin";
import { ProviderService } from "./provider";

export interface Context {
    [symbols.provider.store]: Map<string, any>;
    [symbols.provider.elevations]: Map<string, [string, string]>;

    provider: ProviderService;
    plugin: PluginService;
    lifecycle: Lifecycle;
}

export class Context {
    constructor() {
        this[symbols.provider.store] = new Map();
        this[symbols.provider.elevations] = new Map();

        const self = new Proxy(this, ProviderService.handler);

        self.provider = new ProviderService(self);
        self.plugin = new PluginService(self);
        self.lifecycle = new Lifecycle();

        return self;
    }
}
