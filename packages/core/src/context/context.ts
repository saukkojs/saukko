import { Lifecycle } from "../lifecycle";
import symbols from "../symbols";
import { EventsService } from "./events";
import { PluginService } from "./plugin";
import { ProviderService } from "./provider";

export interface Context {
    [symbols.provider.store]: Map<string, any>;
    [symbols.provider.elevations]: Map<string, [string, string]>;

    provider: ProviderService;
    plugin: PluginService;
    lifecycle: Lifecycle;
    events: EventsService;
}

export class Context {
    constructor() {
        this[symbols.provider.store] = new Map();
        this[symbols.provider.elevations] = new Map();

        const self = new Proxy(this, ProviderService.handler);

        self.provider = new ProviderService(self);
        self.lifecycle = new Lifecycle();
        self.events = new EventsService(self);
        self.plugin = new PluginService(self);

        return self;
    }

    /**
     * 返回一个继承了当前上下文的新上下文实例
     * @param data 需要扩展或覆盖的属性
     */
    extend(data = {}) {
        return Object.create(this, data);
    }
}
