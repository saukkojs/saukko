import log from '@cocotais/logger';
import { LogLevel } from '../types';

export class LoggerService {
    constructor() {}

    log(name: string, level: LogLevel, ...messages: any[]) {
        log(name, level, {
            hasDate: true,
            toConsole: true
        }, ...messages);
    }
}