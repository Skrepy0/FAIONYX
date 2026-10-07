package cn.faionyx.bridge;

/**
 * 桥接参数定义：自制 MOD 声明参数元数据，启动器控制面板据此自动生成控件。
 * 不需要为每个 MOD 单独编写页面。
 */
public final class Param {
    /** 控件类型：开关 / 滑块 / 输入框 / 下拉选项 */
    public enum Kind { SWITCH, SLIDER, TEXT, SELECT }
    /** 生效方式：INSTANT 热修改即时生效；RELOAD_RESOURCES 需重载资源；REJOIN_WORLD 需重进世界；RESTART_GAME 需重启游戏 */
    public enum Apply { INSTANT, RELOAD_RESOURCES, REJOIN_WORLD, RESTART_GAME }
    /** 作用域：CLIENT 客户端参数；SERVER 服务器参数（必须经服务端权限校验，本地接口不得绕过） */
    public enum Scope { CLIENT, SERVER }

    public final String id;
    public final String modId;
    public final String label;
    public final String description;
    public final String group;
    public final Kind kind;
    public final Apply apply;
    public final Scope scope;
    public final Object defaultValue;
    public final Double min;
    public final Double max;
    public final Double step;
    public final String[] options;
    /** 生效条件（null = 无条件），由注册 MOD 自行求值；条件不满足时面板禁用 */
    public final java.util.function.BooleanSupplier visibleWhen;

    private Param(Builder b) {
        this.id = b.id; this.modId = b.modId; this.label = b.label; this.description = b.description;
        this.group = b.group; this.kind = b.kind; this.apply = b.apply; this.scope = b.scope;
        this.defaultValue = b.defaultValue; this.min = b.min; this.max = b.max; this.step = b.step;
        this.options = b.options; this.visibleWhen = b.visibleWhen;
    }

    public static Builder bool(String modId, String id, String label, boolean def) {
        return new Builder(modId, id, label, Kind.SWITCH, def);
    }
    public static Builder slider(String modId, String id, String label, double def, double min, double max, double step) {
        Builder b = new Builder(modId, id, label, Kind.SLIDER, def);
        b.min = min; b.max = max; b.step = step;
        return b;
    }
    public static Builder text(String modId, String id, String label, String def) {
        return new Builder(modId, id, label, Kind.TEXT, def);
    }
    public static Builder select(String modId, String id, String label, String def, String... options) {
        Builder b = new Builder(modId, id, label, Kind.SELECT, def);
        b.options = options;
        return b;
    }

    public static final class Builder {
        private final String modId; private final String id; private final String label;
        private final Kind kind; private final Object defaultValue;
        private String description = "";
        private String group = "通用";
        private Apply apply = Apply.INSTANT;
        private Scope scope = Scope.CLIENT;
        private Double min; private Double max; private Double step;
        private String[] options;
        private java.util.function.BooleanSupplier visibleWhen;
        Builder(String modId, String id, String label, Kind kind, Object def) {
            this.modId = modId; this.id = id; this.label = label; this.kind = kind; this.defaultValue = def;
        }
        public Builder description(String v) { description = v; return this; }
        public Builder group(String v) { group = v; return this; }
        public Builder apply(Apply v) { apply = v; return this; }
        public Builder scope(Scope v) { scope = v; return this; }
        public Builder visibleWhen(java.util.function.BooleanSupplier v) { visibleWhen = v; return this; }
        public Param build() { return new Param(this); }
    }
}
