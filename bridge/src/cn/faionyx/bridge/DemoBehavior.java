package cn.faionyx.bridge;

/**
 * 演示行为：心跳线程按参数节奏在游戏日志打印演示状态。
 * 线程独立于游戏运行，启动器关闭或断开不影响；游戏退出由 JVM 结束自然终止。
 */
final class DemoBehavior {
    private static volatile boolean heartbeat = false;
    private static volatile double interval = 5;
    private static volatile String mode = "平静";
    private static volatile String motto = "慢慢建造一个世界";
    private static Thread thread;

    private DemoBehavior() {}

    static synchronized void setHeartbeat(boolean on) {
        heartbeat = on;
        System.out.println("[FAIONYX Demo] 心跳日志已" + (on ? "开启" : "关闭"));
        if (on && (thread == null || !thread.isAlive())) {
            thread = new Thread(DemoBehavior::loop, "faionyx-demo-heartbeat");
            thread.setDaemon(true);
            thread.start();
        }
    }

    static synchronized void setInterval(double seconds) {
        interval = seconds;
        System.out.println("[FAIONYX Demo] 心跳间隔调整为 " + seconds + " 秒（即时生效）");
    }

    static synchronized void setMode(String next) {
        mode = next;
        System.out.println("[FAIONYX Demo] 演示模式切换为 " + next + "（即时生效）");
    }

    static synchronized void setMotto(String next) {
        motto = next;
        System.out.println("[FAIONYX Demo] 演示座右铭更新为「" + next + "」（即时生效）");
    }

    private static void loop() {
        while (heartbeat) {
            System.out.println("[FAIONYX Demo] 心跳 · 模式=" + mode + " · 座右铭=" + motto + " · 间隔=" + interval + "s");
            try {
                Thread.sleep((long) (interval * 1000));
            } catch (InterruptedException e) {
                return;
            }
        }
    }
}
