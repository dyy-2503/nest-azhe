package app.nest.chat;

import android.os.SystemClock;
import android.webkit.WebView;
import android.widget.Toast;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * Nest 的安卓壳。
 *
 * 返回键的规则（都在这一个地方）：
 *   1. 在任意服务器页面 → 回「换一个服务器」页（不管那个页面是哪个服务器的）
 *   2. 已经在壳里（地址页 / 正在进入）→ 第一次按回到「换服务器」页并提示，2 秒内再按才退出
 *
 * 为什么第 2 条这么绕：服务器慢的时候「正在进入 Nest」会停十几秒（ts.net 走隧道
 * 尤其慢），用户会以为卡死。返回键必须是万能逃生口，不能一按就退出 App。
 */
public class MainActivity extends BridgeActivity {

    /** 壳自带的地址页（带 switch=1 会清掉"上次用过"，停在地址页） */
    private static final String SHELL_SWITCH_URL = "https://localhost/index.html?switch=1";

    /** 上一次按返回的时间，用来实现「再按一次退出」 */
    private long lastBackAt = 0;

    @Override
    public void onBackPressed() {
        Bridge bridge = getBridge();
        WebView webView = bridge != null ? bridge.getWebView() : null;

        if (webView == null) {
            super.onBackPressed();
            return;
        }

        String url = webView.getUrl();
        boolean inShell = url == null || isShellPage(url);

        if (!inShell) {
            // 在任何服务器页面：回换服务器页，绝不退出
            webView.loadUrl(SHELL_SWITCH_URL);
            lastBackAt = 0;
            return;
        }

        // 已经在壳里：2 秒内第二次才退出
        long now = SystemClock.uptimeMillis();
        if (now - lastBackAt < 2000) {
            super.onBackPressed();
            return;
        }
        lastBackAt = now;
        webView.loadUrl(SHELL_SWITCH_URL);
        Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show();
    }

    /** 壳自己的页面（地址页 / 正在进入 / 加载失败页）都不是服务器页面 */
    private boolean isShellPage(String url) {
        if (url.startsWith("https://localhost")) return true;
        if (url.startsWith("file://")) return true;
        // 加载失败时 WebView 会停在 chrome-error:// 或 data: 页面上，也算壳里
        if (url.startsWith("chrome-error://")) return true;
        if (url.startsWith("data:")) return true;
        return false;
    }
}
