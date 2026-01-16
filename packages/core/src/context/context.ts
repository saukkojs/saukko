import { ProviderService } from "./provider";

export interface Context {
    provider: ProviderService;
}

export class Context {
    constructor() {
        const self = new Proxy(this, ProviderService.handler);

        self.provider = new ProviderService(self);

        return self;
    }
}
