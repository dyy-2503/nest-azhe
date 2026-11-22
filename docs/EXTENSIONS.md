# 扩展包（给 AI 加能力）

创建 AI 时第三步可以勾「扩展包」。扩展不是装代码，而是**一段教它怎么做事的话**，
被塞进这个 AI 的系统提示里。

## 为什么不做成"装代码的插件"

- 我们这款应用是给朋友之间用的，装第三方代码 = 把自家电脑交给陌生人
- 扩展只需要"教它做事的方式"，用一段 prompt 就够了
- 所以现在的实现：**只读一个 JSON 文件，不下载可执行文件、不执行任何代码**

## 一个扩展长什么样

GitHub 仓库根目录放一个 `nest-extension.json`：

```json
{
  "name": "写作助手",
  "version": "1.0.0",
  "description": "把杂乱的想法写成通顺的文字",
  "author": "你的名字",
  "prompt": "你擅长把杂乱的想法写成通顺的文字。用户给你草稿时，先问清楚写给谁、要多长，再改写；不要堆形容词。"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| name | 是（不填用仓库名） | 显示在向导里的名字，最长 40 字 |
| version | 否 | 显示用 |
| description | 否 | 一句话说明 |
| author | 否 | 谁写的 |
| prompt | **是** | 最长 8000 字，会被拼进 AI 的系统提示 |

## 怎么装

1. 建一个**公开** GitHub 仓库，把 `nest-extension.json` 放在根目录（默认分支 main 或 master）
2. 在 Nest 里：设置 → 我的 AI 成员 → 扩展包 → 粘仓库地址 → 安装
3. 或者在创建 AI 的第三步直接粘地址装

离线/试写时可以装本地文件：

```powershell
# 直接指定本机 JSON 文件
POST /api/extensions/install  { "url": "D:\\path\\to\\nest-extension.json" }
```

本仓库里的 `docs/example-extension.json` 就是一个可用的样例。

## 安全边界

- 只允许 `https://github.com/<owner>/<repo>`（自动转成 raw.githubusercontent.com 拉取，main/master 都试）
- 不下载除此以外的任何文件
- prompt 会被截断到 8000 字
- 装进来只是文本，删掉扩展不影响聊天记录
