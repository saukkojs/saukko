export interface PluginDepenciesRegistry { };
export interface Events {
    'internal.ready': () => void;
    'internal.dispose': () => void;
};