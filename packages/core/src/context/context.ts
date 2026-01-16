import { ProviderService } from "./provider";

export class Context {
    provider: ProviderService;

    constructor() {
        this.provider = new ProviderService(this);
    }
}
