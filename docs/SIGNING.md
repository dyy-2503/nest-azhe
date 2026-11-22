# Windows 代码签名（以及为什么第一次运行会弹 SmartScreen）

## 现状

安装包 `Nest-Setup-*.exe` **没有签名**。Windows 不知道发布者是谁，会：

- 从浏览器下载后，第一次运行弹 **"Windows 已保护你的电脑"**
- 用户要点「更多信息 → 仍要运行」才能装

这不是 bug，是 Windows 对"未知发布者"的默认态度。**只有用受信任的证书签名**才能消除（而且签名后还需要攒"声誉"，新证书前期仍可能提示）。

## 三条路

### A. 不签名（现状）

- 成本：0
- 体验：每次新用户第一次装都要点两下
- 适合：只给熟人朋友装

### B. 买一张代码签名证书（OV / EV）

- 成本：OV 约 ¥1000–3000/年，EV 约 ¥3000–6000/年（EV 对新证书的 SmartScreen 更友好，但也要攒声誉）
- 购买渠道：DigiCert / Sectigo / Globalsign 及其中国区代理；需要**企业营业执照**或个体工商户资质
- 拿到的是 `.pfx` 文件（OV）或硬件 U 盾（EV，CI 上没法直接签）

### C. Azure Trusted Signing（目前最便宜的正规路线）

- 成本：约 $9.99/月（Basic）
- 要求：Azure 订阅 + **个人/企业身份验证**（个人可用，需身份证明 + 一定经营/活跃证明）
- 优点：key 存在微软云里，CI 直接签，不用管 PFX 泄露
- 缺点：审核要几天；国内访问 Azure 需要网络条件

## 配好之后怎么用（代码已经预留）

### B 路线：GitHub Secrets 里放 PFX

1. 把证书转成 base64：
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes('D:\cert\nest.pfx')) | Set-Content cert.b64
   ```
2. GitHub 仓库 → Settings → Secrets and variables → Actions → 新建：
   - `WIN_CSC_LINK` = `cert.b64` 的内容
   - `WIN_CSC_KEY_PASSWORD` = PFX 密码
3. 不需要改任何代码：`electron-builder` 检测到这两个环境变量就会签名（`desktop.yml` 已经把它们透传进来）

### C 路线：Azure Trusted Signing

需要 `trusted-signing-cli` 或 electron-builder 的 azure 签名配置：

```json
"win": {
  "azureSignOptions": {
    "publisherName": "你的公司名",
    "endpoint": "https://eus.codesigning.azure.net/",
    "codeSigningAccountName": "账号名",
    "certificateProfileName": "证书配置名"
  }
}
```

再在 CI 里配 `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`。

## 验证签名是否生效

```powershell
Get-AuthenticodeSignature .\dist\Nest-Setup-0.2.0.exe | Format-List Status, SignerCertificate
```

`Status: Valid` 且 `SignerCertificate.Subject` 是你的名字/公司，就成功了。

## 现在能做的替代方案

在拿到证书之前，可以在下载页/README 里写清楚：

> 安装时如果提示"Windows 已保护你的电脑"，点「更多信息」→「仍要运行」。
> 这个提示是因为我们没有购买代码签名证书（约 ¥1000/年），与软件安全性无关；
> 源码完全公开在 GitHub，可以自行核对：`git clone` 后 `npm run package` 自己打包。

另外可以**同时提供源码 zip**（`nest-v*.zip`）——愿意自己跑的人可以完全绕过安装器。
