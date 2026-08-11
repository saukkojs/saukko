import type { LoggerService } from './services/logger';
import type { PluginService } from './services/plugin';
import type { Scope } from './scope';
import { pluginDependencyDiagnose } from './utils';

export class App {
    constructor(private logger: LoggerService, private plugin: PluginService, private scope: Scope) {}

    async start() {
        this.logger.log('app', 'info', 'Starting app...');
        const data = pluginDependencyDiagnose(this.plugin, this.scope);
        if (data.issues.length > 0) {
            for (const issue of data.issues) {
                if (issue.type === 'missing-dependency') {
                    // 缺失依赖是暂时状态：插件挂起等待，依赖补齐后自动执行并启动。
                    this.logger.log('app', 'info', `- Plugin ${issue.plugin} is waiting for dependencies: ${issue.details.join(', ')}`);
                } else if (issue.type === 'circular-dependency') {
                    // 循环依赖是硬错误：无法通过等待解决，不启动也不标记期望启用。
                    this.logger.log('app', 'error', `- Plugin ${issue.plugin} has circular dependencies and will not start: ${issue.details.join(' -> ')}`);
                }
            }
        }
        // 先按拓扑序启动依赖就绪的插件。
        for (const pluginName of data.order) {
            await this.plugin.apply(pluginName);
        }
        // 等待依赖的插件标记为期望启用：依赖补齐后自动执行主体并启动。
        for (const issue of data.issues) {
            if (issue.type === 'missing-dependency') {
                await this.plugin.apply(issue.plugin);
            }
        }
        this.logger.log('app', 'info', `App started, ${data.order.length} plugins applied.`);
    }

    async stop() {
        this.logger.log('app', 'info', 'Stopping app...');
        const plugins = this.plugin.map();
        const enabled = (name: string) => plugins.get(name)?.enabled === true;
        // 卸载顺序取启动拓扑顺序的逆序：依赖方先停止，与作用域“先子后父”的销毁顺序一致。
        const diagnosis = pluginDependencyDiagnose(this.plugin, this.scope);
        const stopOrder = diagnosis.order.filter(enabled).reverse();
        // 未进入启动序列的插件（未启用或存在依赖问题）排在最后兜底卸载：
        // 应用停止是终态操作，全部插件的子作用域都要销毁。
        for (const name of plugins.keys()) {
            if (!stopOrder.includes(name)) {
                stopOrder.push(name);
            }
        }
        const errors: unknown[] = [];
        for (const name of stopOrder) {
            try {
                await this.plugin.remove(name);
            } catch (error) {
                errors.push(error);
                this.logger.log('app', 'error', `Failed to stop plugin ${name}.`, error);
            }
        }
        this.logger.log('app', 'info', 'App stopped.');
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Multiple plugins failed to stop.');
    }
}
