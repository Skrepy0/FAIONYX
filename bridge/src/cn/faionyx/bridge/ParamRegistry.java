package cn.faionyx.bridge;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 参数注册中心：MOD 注册参数定义，值随改随存（faionyx-bridge-config.json），
 * 并支持恢复默认。热修改参数立即应用到注册时提供的监听器。
 */
public final class ParamRegistry {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Map<String, Param> PARAMS = new LinkedHashMap<>();
    private static final Map<String, Object> VALUES = new LinkedHashMap<>();
    private static final Map<String, java.util.function.Consumer<Object>> LISTENERS = new LinkedHashMap<>();
    private static Path configFile;

    private ParamRegistry() {}

    public static void init(Path gameDir) {
        configFile = gameDir.resolve("faionyx-bridge-config.json");
        load();
    }

    /** 注册参数并附带变更监听器（热修改参数在监听器里应用到游戏实际状态）。 */
    public static void register(Param def, java.util.function.Consumer<Object> listener) {
        PARAMS.put(def.id, def);
        VALUES.putIfAbsent(def.id, def.defaultValue);
        if (listener != null) LISTENERS.put(def.id, listener);
    }

    public static Param[] params() { return PARAMS.values().toArray(new Param[0]); }
    public static Param param(String id) { return PARAMS.get(id); }
    public static Object value(String id) { return VALUES.get(id); }
    public static boolean bool(String id) { return Boolean.TRUE.equals(VALUES.get(id)); }
    public static double number(String id) { return ((Number) VALUES.get(id)).doubleValue(); }
    public static String text(String id) { return String.valueOf(VALUES.get(id)); }

    /** 修改参数：校验类型/范围/生效条件 → 应用监听器 → 持久化。返回生效提示（null = 即时生效）。 */
    public static synchronized String set(String id, Object value) {
        Param def = PARAMS.get(id);
        if (def == null) throw new IllegalArgumentException("未知参数：" + id);
        Object checked = validate(def, value);
        VALUES.put(id, checked);
        java.util.function.Consumer<Object> listener = LISTENERS.get(id);
        if (listener != null) listener.accept(checked);
        save();
        return switch (def.apply) {
            case INSTANT -> null;
            case RELOAD_RESOURCES -> "已修改，需重载资源（F3+T）后生效";
            case REJOIN_WORLD -> "已修改，需重新进入世界后生效";
            case RESTART_GAME -> "已修改，需重启游戏后生效";
        };
    }

    /** 恢复默认（id 为空则全部恢复）。 */
    public static synchronized void reset(String id) {
        if (id == null) {
            for (Param def : PARAMS.values()) {
                VALUES.put(def.id, def.defaultValue);
                java.util.function.Consumer<Object> listener = LISTENERS.get(def.id);
                if (listener != null) listener.accept(def.defaultValue);
            }
        } else {
            Param def = PARAMS.get(id);
            if (def == null) throw new IllegalArgumentException("未知参数：" + id);
            VALUES.put(id, def.defaultValue);
            java.util.function.Consumer<Object> listener = LISTENERS.get(id);
            if (listener != null) listener.accept(def.defaultValue);
        }
        save();
    }

    private static Object validate(Param def, Object value) {
        switch (def.kind) {
            case SWITCH -> {
                if (value instanceof Boolean b) return b;
                if ("true".equals(value) || "false".equals(value)) return Boolean.valueOf((String) value);
                throw new IllegalArgumentException(def.label + " 需要 true/false");
            }
            case SLIDER -> {
                double v = value instanceof Number n ? n.doubleValue() : Double.parseDouble(String.valueOf(value));
                if (def.min != null && v < def.min) v = def.min;
                if (def.max != null && v > def.max) v = def.max;
                if (def.step != null && def.step > 0) {
                    double base = def.min != null ? def.min : 0;
                    v = base + Math.round((v - base) / def.step) * def.step;
                }
                return v;
            }
            case SELECT -> {
                String v = String.valueOf(value);
                if (def.options != null) {
                    for (String o : def.options) if (o.equals(v)) return v;
                    throw new IllegalArgumentException(def.label + " 的可选值仅限：" + String.join("、", def.options));
                }
                return v;
            }
            default -> {
                return String.valueOf(value);
            }
        }
    }

    private static void load() {
        if (configFile == null || !Files.isRegularFile(configFile)) return;
        try {
            Map<String, Object> stored = GSON.fromJson(Files.readString(configFile, StandardCharsets.UTF_8), new TypeToken<Map<String, Object>>() {}.getType());
            if (stored != null) VALUES.putAll(stored);
        } catch (Exception ignored) { /* 配置损坏则使用默认值 */ }
    }

    private static void save() {
        if (configFile == null) return;
        try {
            Files.writeString(configFile, GSON.toJson(VALUES), StandardCharsets.UTF_8);
        } catch (IOException ignored) { /* 写入失败不影响游戏 */ }
    }
}
