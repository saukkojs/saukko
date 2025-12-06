import { App } from "./app";
import { Container } from "./container";
import { ConfigService } from "./services/config";
import { LoggerService } from "./services/logger";
import { Config } from "./types";

export function injectionProvider(container: Container, config: Config) {
    container.register('logger', LoggerService)
    container.register('config', ConfigService)

    container.get('config').setConfig(config);

    container.register('app', App)
}