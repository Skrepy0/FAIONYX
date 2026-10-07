package cn.faionyx.bridge;

/**
 * 演示 MOD（faionyx-demo）：参数注册接口的完整示例。
 * 声明参数名称、说明、分组、类型、默认值、取值范围与生效方式后，
 * 启动器控制面板自动生成对应控件；这里的演示效果通过游戏日志可观察：
 * demoHeartbeat 开启后按 demoInterval 节奏在日志打印当前演示状态。
 */
public final class DemoModule {
    private DemoModule() {}

    public static void register() {
        ParamRegistry.register(
            Param.bool("faionyx-demo", "demoHeartbeat", "演示心跳日志", false)
                .group("演示 MOD")
                .description("开启后按设定间隔在游戏日志中打印演示状态，用于验证实时修改已生效")
                .apply(Param.Apply.INSTANT)
                .build(),
            value -> DemoBehavior.setHeartbeat((Boolean) value)
        );
        ParamRegistry.register(
            Param.slider("faionyx-demo", "demoInterval", "心跳间隔（秒）", 5, 1, 30, 1)
                .group("演示 MOD")
                .description("演示心跳的日志打印间隔，拖动滑块即时生效")
                .apply(Param.Apply.INSTANT)
                .build(),
            value -> DemoBehavior.setInterval(((Number) value).doubleValue())
        );
        ParamRegistry.register(
            Param.select("faionyx-demo", "demoMode", "演示模式", "平静", "平静", "欢快", "激昂")
                .group("演示 MOD")
                .description("演示参数：选择不同模式会改变心跳日志的措辞")
                .apply(Param.Apply.INSTANT)
                .build(),
            value -> DemoBehavior.setMode(String.valueOf(value))
        );
        ParamRegistry.register(
            Param.text("faionyx-demo", "demoMotto", "演示座右铭", "慢慢建造一个世界")
                .group("演示 MOD")
                .description("演示文本参数：内容会出现在心跳日志里")
                .apply(Param.Apply.INSTANT)
                .build(),
            value -> DemoBehavior.setMotto(String.valueOf(value))
        );
        // 非热修改示例：演示"需重启游戏"的参数
        ParamRegistry.register(
            Param.bool("faionyx-demo", "demoUnsafeFlag", "实验性引擎（重启生效）", false)
                .group("演示 MOD")
                .description("演示非热修改参数：修改后需重启游戏")
                .apply(Param.Apply.RESTART_GAME)
                .build(),
            null
        );
        // 服务器参数示例：面板只读展示，本地接口拒绝修改
        ParamRegistry.register(
            Param.slider("faionyx-demo", "demoServerTickRate", "服务器 TPS 倍率（演示只读）", 1, 0.5, 4, 0.5)
                .group("演示 MOD")
                .description("服务器参数示例：必须由服务端校验权限，本地接口会拒绝修改")
                .apply(Param.Apply.INSTANT)
                .scope(Param.Scope.SERVER)
                .build(),
            null
        );
    }
}
