import { Container } from "../container";
import { LoggerService } from "./logger";

export class PluginService {
    static inject = ['container', 'logger'] as const;

    constructor(
        private container: Container,
        private logger: LoggerService
    ) {}
    
}