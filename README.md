# Claude Relay Verifier

验证一个 Anthropic 兼容中转站(relay)是否真的提供了它声称的模型 —— 以 `claude-opus-5` 的 `max` 思考档位为例。

两个验证轴:

1. **模型身份(model identity)** —— 通过 **thinking-block 签名(signature)回放测试**。这是唯一密码学级的判据。
2. **思考档位(effort tier)** —— 通过 `effort=max` 下的 output-token 用量对比,判断是否被"注水"(偷偷降档)。

## 原理

### 1. 签名回放(硬测试)

Anthropic 用扩展/自适应思考时,每个 `thinking` 块带一个 `signature` 字段 —— 这是 Anthropic 服务器生成的**不透明加密签名**,只能在官方 API 上验证。

本工具把中转站返回的 thinking 块**原样(一个字节不改)回传给官方 API**:

- 官方**接受 (2xx)** → 这块思考确实是 Anthropic 为该模型签发的 → 模型身份为真。
- 官方**拒绝 (400, signature/thinking 相关错误)** → 该块是伪造的、被篡改的,或来自其他提供方。

> 注意:签名验证的是**模型身份**,不是**思考档位**。即使签名通过,中转站仍可能把 `effort` 从 `max` 降到 `high`/`medium` 省钱 —— 这正是第二条轴要查的。

### 2. Effort 用量仪表(软信号)

同一个 prompt、同样 `effort=max`,分别打官方和中转站,对比:

- 服务器自报的 `model` 字段(必要非充分)
- thinking 块是否带签名(中转站完全没有签名 = 思考绝非官方签发)
- `usage.output_tokens` 的比值(中转站/官方)。显著偏低 → 疑似档位注水。

## 用法

```bash
npm install
npm run dev
# 打开 http://localhost:3000
```

或生产模式:

```bash
npm run build && npm run start
```

页面里:

1. **① Official API** —— 填官方 base URL(`https://api.anthropic.com`)和你的官方 key,作为基准。
2. **② Relay under test** —— 填中转站 base URL(如 qcode.cc)和中转 key。
3. 选模型 / effort(默认 `claude-opus-5` + `max`)、max_tokens、prompt(两边相同)。
4. **Run comparison** → 看两边的 `model`、签名数、`output_tokens` 对比。
5. **Signature replay** → 把中转站的 thinking 块回传给官方 API,得到密码学级判定。

> base URL 带不带 `/v1` 都行,服务端会归一化。

## 结果怎么读

| 现象 | 结论 |
|---|---|
| 回放被官方**接受** | 中转站的 thinking 块确为 Anthropic 签发,模型身份属实(档位另查 token 仪表) |
| 回放被官方**拒绝** | 三种可能:① 换了别的模型并伪造 thinking;② 中转站做了格式转译/改写,破坏了签名(未必换模型);③ 传输中被改。需结合是否"原样透传"进一步区分 |
| 中转站**根本没有签名** | 其 thinking 一定不是官方签发 |
| `output_tokens` 中转站/官方 ≪ 1 | 疑似 `effort` 被降档(注水),与是否换模型无关 |

**关于"某网站说签名不对"**:签名不对 ⇒ 说明响应不是由 Anthropic 官方基础设施原样签发/透传,可能是作假、也可能是中转站的技术性转译/缓存改写。要定性为"故意换模型",应以你自己用官方 API 回放被拒为准(且确认是同模型、方法正确)。

## 隐私

- Key 只随请求发到本地这个服务,用于调用你指定的 API;不写日志、不持久化。
- 可选在浏览器 `localStorage` 记住 key(勾选框,仅存于你自己的浏览器)。

## 技术

Next.js (App Router) + TypeScript + Tailwind。两个服务端路由:

- `POST /api/probe` —— 向指定 base URL 发一次带 thinking 的请求,回传 `model` / 签名 / `usage` / 预览。
- `POST /api/replay` —— 把捕获的 thinking 块原样回传给官方 API,返回 `accepted` / `signature_rejected` / `other_error`。
