package app.nest.chat;

import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * Nest 的安卓壳。
 *
 * 除了 Capacitor 默认行为，这里只加一件事：返回键。
 *
 * 为什么不用网页里的按钮？
 * App 在「本地世界」(http://127.0.0.1:8787) 时，Capacitor 不会往这个非允许源的页面里
 * 注入 JS 桥，网页里的「服务器」按钮就挂不出来；而服务器页面（PC 那台）也各有各的
 * 网页版本。返回键是原生能力，不受这些影响：
 *
 *   在任意服务器页面按返回 → 回壳里的「换一个服务器」页
 *   在壳页面（地址页）按返回 → 正常退出 App
 */
public class MainActivity extends BridgeActivity {

    /** 壳自带的地址页（带 switch=1 会清掉"上次用过"，停在地址页） */
    private static final String SHELL_SWITCH_URL = "https://localhost/index.html?switch=1";

    @Override
    public void onBackPressed() {
        Bridge bridge = getBridge();
        WebView webView = bridge != null ? bridge.getWebView() : null;
        String url = webView != null ? webView.getUrl() : null;

        if (url != null && !isShellPage(url)) {
            // 当前在某个服务器的网页里：回「换服务器」页，而不是直接退出
            webView.loadUrl(SHELL_SWITCH_URL);
            return;
        }

        super.onBackPressed();
    }

    /** 壳自己的页面（地址页 / 正在进入）都跑在 https://localhost 下 */
    private boolean isShellPage(String url) {
        return url.startsWith("https://localhost/")
                || url.startsWith("https://localhost")
                || url.startsWith("file://");
    }
}
