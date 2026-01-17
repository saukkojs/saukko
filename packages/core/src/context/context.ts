import symbols from "../symbols";
import { ProviderService } from "./provider";

export interface Context {
    [symbols.provider.store]: Map<string, any>;
    [symbols.provider.elevations]: Map<string, [string, string]>;

    provider: ProviderService;
}

export class Context {
    constructor() {
        this[symbols.provider.store] = new Map();
        this[symbols.provider.elevations] = new Map();

        const self = new Proxy(this, ProviderService.handler);

        self.provider = new ProviderService(self);

        return self;
    }
}
