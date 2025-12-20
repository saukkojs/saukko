export interface PluginDependenciesRegistry { };
export interface Events {
    'internal.ready': () => void;
    'internal.dispose': () => void;
};