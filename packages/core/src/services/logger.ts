import log from '@cocotais/logger';
import { LogLevel, LogLevelExtended } from '../types';

const env = process.env;

export class LoggerService {
    constructor() {}

    log(name: string, level: LogLevel, ...messages: any[]) {
        log(name, level, {
            hasDate: true,
            toConsole: true,
            toFile: 'logs/saukko.log',
            loglevel: env.SAUKKO_LOG_LEVEL as LogLevelExtended
        }, ...messages);
    }
}