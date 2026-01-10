export class Context {
    /**
     * 向 Context 提供一个属性
     * @param key 在 Context 上的属性名
     * @param value 属性值
     */
    provide(key: string, value: any) {
        (this as any)[key] = value;
    }
    /**
     * 将 Context 上某个属性的方法提升为 Context 的直接方法
     * @param key 在 Context 上的属性名
     * @param methods 方法名列表，或一个以原属性内方法名为键、新方法名为值的对象
     */
    elevate(key: string, methods: string[] | Record<string, string>) {
        if (Array.isArray(methods)) {
            methods = methods.reduce((obj, method) => {
                obj[method] = method;
                return obj;
            }, {} as Record<string, string>);
        }
        for (const [method, as] of Object.entries(methods)) {
            (this as any)[as] = (this as any)[key][method].bind((this as any)[key]);
        }
    }
}
